const _ = require('lodash')
const axios = require('axios')

module.exports = async (serviceId, shopId, orderIds, endpoint) => {
  if (!serviceId) throw new Error('serviceId is empty')
  if (!shopId) throw new Error('shopId is empty')
  if (_.isEmpty(orderIds)) throw new Error('orderIds is empty')
  if (!endpoint) throw new Error('endpoint is invalid')

  const res = await axios.post(
    `${endpoint}/api/${serviceId}/send-order-email`,
    { shopId, orderIds }
  )

  return res.data
}
