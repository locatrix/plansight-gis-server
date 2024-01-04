import express, { query } from 'express'
import { convert, create } from 'xmlbuilder2'
import { getCurrentDataSource } from '../data-sources/currentDataSource.js'
import { EXCLUDED_WFS_COLUMNS } from './excluded.js'
import { parseWfsParams } from './parseParams.js'

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

  const { typeNames, bbox, outputFormat, count } = parsed

  let queryParams = {}
  let n = 0
  for (let typeName of typeNames) {
    queryParams[`$param${n++}`] = typeName
  }
  let featuresets = typeNames.map((t, i) => `$param${i}`).join(',')

  // Bounding Box Params
  if (bbox) {
    for (let i = 0; i < bbox.length; i++) {
      queryParams[`$bbox${i}`] = bbox[i]
    }
  }

  // Count Param
  if (count) {
    queryParams[`$count`] = count
  }

  let features = []
  let numberMatched = null
  if (true) {
    features = await dataSource.queryFeaturePackage(/* sql */`
      SELECT *
      FROM all_features
      WHERE featureset IN (${featuresets})
      ${bbox ? 'AND x > $bbox0 AND y > $bbox1 AND x < $bbox2 AND y < $bbox3' : ''}
      ${count ? 'LIMIT $count' : ''}
    `, {
      ...queryParams
    })

    if (count || bbox) {
      // It is possible for features matched to differ from the features returned
      // This additional query returns the total number of features which match the request parameters
      numberMatched = await dataSource.queryFeaturePackage(/* sql */`
      SELECT COUNT(*) AS COUNT
      FROM all_features
      WHERE featureset IN (${featuresets})
      ${bbox ? 'AND x > $bbox0 AND y > $bbox1 AND x < $bbox2 AND y < $bbox3' : ''}
    `, {
      ...queryParams
    })
    numberMatched = numberMatched[0]['COUNT']
    } else {
      numberMatched = features.length
    }
  }

  // add URL properties to the features
  const serverUrl = `${req.protocol}://${req.get('host')}`
  features = features.map(f => mapFeature(serverUrl, f))

  if (outputFormat === 'GEOJSON') {
    let obj = {
      type: 'FeatureCollection',
      features: features.map(feature => {
        let properties = {
          GmlID: `Point.${feature.id}`
        }

        for (let key of Object.keys(feature)) {
          properties[key] = `${feature[key]}`
        }

        return {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [
              feature.x,
              feature.y
            ]
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
        '@xmlns:xsi': `http://www.w3.org/2001/XMLSchema-instance ${serverUrl}/?SERVICE=WFS&VERSION=2.0.0&REQUEST=DescribeFeatureType&TYPENAME=plans`,
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
                featureXml['wfs:member'][feature.featureset][key] = {
                  'gml:Point': {
                    '@srsName': 'urn:ogc:def:crs:EPSG::3857',
                    '@srsDimension': 2,
                    '@gml:id': `GmlPoint.${feature.id}`,
                    'gml:pos': `${feature.x} ${feature.y}`
                  }
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
