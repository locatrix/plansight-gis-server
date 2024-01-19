import express, { query } from 'express'
import { convert, create } from 'xmlbuilder2'
import { getCurrentDataSource } from '../data-sources/currentDataSource.js'
import { EXCLUDED_WFS_COLUMNS } from './excluded.js'
import { parseWfsParams } from './parseParams.js'
import { getServerUrl } from '../util/serverUrl.js'

function mapFeature (serverUrl, feature) {
  return {
    viewerUrl: `${serverUrl}/viewer#camera=${feature.latitude},${feature.longitude},18.00z`,
    ...feature
  }
}

/**
 * @param {express.Request} req
 * @param {express.Response} res
 */
export async function wfsGetFeature (req, res) {
  const dataSource = getCurrentDataSource()
  await dataSource.refresh(false)

  const parsed = parseWfsParams(req, res)
  if (parsed == null) {
    return
  }

  const { typeNames, bbox, outputFormat, count, srsName } = parsed

  // FeatureSet Params
  let queryParams = {}
  let n = 0
  for (let typeName of typeNames) {
    queryParams[`$param${n++}`] = typeName
  }
  const featureSets = typeNames.map((t, i) => `$param${i}`).join(',')

  // Bounding Box Params
  if (bbox != null) {
    for (let i = 0; i < bbox.length; i++) {
      queryParams[`$bbox${i}`] = bbox[i]
    }
  }

  // Count Param
  if (count != null) {
    queryParams[`$count`] = count
  }

  let features = await dataSource.queryFeaturePackage(/* sql */`
    SELECT *
    FROM all_features
    WHERE featureset IN (${featureSets})
    ${bbox != null ? 'AND x > $bbox0 AND y > $bbox1 AND x < $bbox2 AND y < $bbox3' : ''}
    ${count != null ? 'LIMIT $count' : ''}
  `, {
    ...queryParams
  })

  let numberMatched = features.length
  if (count != null) {
    // the next query doesn't use the $count param, and sqlite can
    // error out if you include params that don't match your sql,
    // so make sure to remove it!
    const { $count, ...remainingQueryParams } = queryParams
    
    // It is possible for features matched to differ from the features returned
    // This additional query returns the total number of features which match the request parameters
    const totalCountResult = await dataSource.queryFeaturePackage(/* sql */`
      SELECT COUNT(*) AS totalCount
      FROM all_features
      WHERE featureset IN (${featureSets})
      ${bbox != null ? 'AND x > $bbox0 AND y > $bbox1 AND x < $bbox2 AND y < $bbox3' : ''}
    `, {
      ...remainingQueryParams
    })
    numberMatched = totalCountResult[0]['totalCount']
  }

  // add URL properties to the features
  const serverUrl = getServerUrl(req)
  features = features.map(f => mapFeature(serverUrl, f))

  if (outputFormat === 'GEOJSON') {
    let obj = {
      type: 'FeatureCollection',
      features: features.map(feature => {
        let properties = {
          GmlID: `Point.${feature.id}`
        }

        for (let key of Object.keys(feature)) {
          if (key === 'geom') {
            continue
          }

          properties[key] = `${feature[key]}`
        }

        let coordinates = [
          feature.x,
          feature.y
        ]

        if (srsName === 'EPSG:4326') {
          coordinates = [feature.longitude, feature.latitude]
        }

        return {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates
          },
          properties
        }
      })
    }

    res.set('Content-Type', 'application/json')
    res.status(200)
    res.send(JSON.stringify(obj, null, 2))
  } else {
    const obj = {
      'wfs:FeatureCollection': {
        '@xmlns:wfs': "http://www.opengis.net/wfs/2.0",
        '@xmlns:gml': "http://www.opengis.net/gml/3.2",
        '@xmlns:xsi': `http://www.w3.org/2001/XMLSchema-instance`,
        '@numberReturned': features.length,
        '@numberMatched': numberMatched,
        '#': [
          ...features.map(feature => {
            // NOTE: We assume all features (regardless of they are) have an id and featureset property.
            // NOTE: the id & featureset properties will be omitted because they appear to be reserved properties from other namespaces.
            let featureXml = { 'wfs:member': { '@xmlns:wfs': "http://www.opengis.net/wfs/2.0" }}
            featureXml['wfs:member'][feature.featureset] = { '@gml:id': `Point.${feature.id}` }

            for (let key of Object.keys(feature)) {
              if (EXCLUDED_WFS_COLUMNS.has(key)) {
                continue
              }

              if (key === 'geom') {
                if (srsName === 'EPSG:3857') {
                  featureXml['wfs:member'][feature.featureset][key] = {
                    'gml:Point': {
                      '@srsName': 'urn:ogc:def:crs:EPSG::3857',
                      '@srsDimension': 2,
                      '@gml:id': `GmlPoint.${feature.id}`,
                      'gml:pos': `${feature.x} ${feature.y}`
                    }
                  }
                } else if (srsName === 'EPSG:4326') {
                  featureXml['wfs:member'][feature.featureset][key] = {
                    'gml:Point': {
                      '@srsName': 'urn:ogc:def:crs:EPSG::4326',
                      '@srsDimension': 2,
                      '@gml:id': `GmlPoint.${feature.id}`,
                      'gml:pos': `${feature.latitude} ${feature.longitude}`
                    }
                  }
                } else {
                  throw new Error('unsupported SRS')
                }
              } else {
                featureXml['wfs:member'][feature.featureset][key] = `${feature[key]}`
              }
            }

            return featureXml
          })
        ]
      }
    }

    const root = create({ version: '1.0' }).ele(obj)
    
    // convert the XML tree to string
    const xml = root.end({ prettyPrint: true })

    res.set('Content-Type', 'text/xml')
    res.status(200)
    res.send(xml)
  }
}
