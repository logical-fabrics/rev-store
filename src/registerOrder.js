const axios = require('axios')

module.exports = async (serviceId, metadata, endpoint) => {
  if (!serviceId) throw new Error('serviceId is empty')
  if (!metadata) throw new Error('metadata is empty')
  if (!endpoint) throw new Error('endpoint is invalid')

  const res = await axios.post(`${endpoint}/api/${serviceId}/register-order`, {
    metadata,
  })

  return res.data
}
