const axios = require('axios')
const jwt = require('jsonwebtoken')

module.exports = async (jwtStr, endpoint) => {
  if (!jwtStr) throw new Error('jwtStr is invalid')
  if (!endpoint) throw new Error('endpoint is invalid')

  const res = await axios.get(`${endpoint}/api/rev-store/public-key`)

  try {
    const decoded = await jwt.verify(
      jwtStr,
      Buffer.from(res.data.publicKey, 'base64'),
      { algorithms: ['RS256'] }
    )

    return decoded
  } catch (e) {
    console.log(e)
    return null
  }
}
