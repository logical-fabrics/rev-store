const axios = require('axios')

const verify = require('./verify')

module.exports = async (jwtStr, endpoint) => {
  if (!jwtStr) throw new Error('jwtStr is invalid')
  if (!endpoint) throw new Error('endpoint is invalid')

  const decoded = await verify(jwtStr, endpoint)

  if (_.isNull(decoded)) throw new Error('invalid signature')

  const urls = _.map(
    decoded.files,
    (file) =>
      `https://storage.googleapis.com/${decoded.bucketName}/rev-store/${decoded.id}/${file}`
  )

  return urls
}
