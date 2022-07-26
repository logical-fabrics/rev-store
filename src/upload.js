const _ = require('lodash')
const axios = require('axios')

module.exports = async (metadata, files, dataUrls, bucketName, endpoint) => {
  if (!metadata) throw new Error('metadata is empty')
  if (_.isEmpty(files)) throw new Error('files is empty')
  if (_.isEmpty(dataUrls)) throw new Error('dataUrls is empty')
  if (!bucketName) throw new Error('bucketName is invalid')
  if (!endpoint) throw new Error('endpoint is invalid')

  try {
    const res = await axios.post(`${endpoint}/api/rev-store/upload`, {
      metadata,
      files,
      dataUrls,
      bucketName,
    })

    return res.data.jwt
  } catch (e) {
    console.log(e)
    return null
  }
}
