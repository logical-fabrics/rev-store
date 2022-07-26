const _ = require('lodash')
const axios = require('axios')

module.exports = async (metadata, files, dataUrls, endpoint) => {
  if (!metadata) throw new Error('metadata is empty')
  if (_.isEmpty(files)) throw new Error('files is empty')
  if (_.isEmpty(dataUrls)) throw new Error('dataUrls is empty')
  if (!endpoint) throw new Error('endpoint is invalid')

  const res = await axios.post(`${endpoint}/api/rev-store/upload`, {
    metadata,
    files,
    dataUrls,
  })

  return res.data.jwt
}
