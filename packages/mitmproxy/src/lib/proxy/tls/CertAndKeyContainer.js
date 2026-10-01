const tlsUtils = require('./tlsUtils')
const { LRUCache } = require('lru-cache')
const log = require('../../../utils/util.log.server')

const DEFAULT_MAX_LENGTH = 256

module.exports = class CertAndKeyContainer {
  constructor ({
    maxLength = DEFAULT_MAX_LENGTH,
    caCert,
    caKey,
  }) {
    // 缓存键：dnsName
    this.cache = new LRUCache({
      maxSize: maxLength > 0 ? maxLength : DEFAULT_MAX_LENGTH,
      sizeCalculation: () => {
        return 1
      },
      dispose: (_evictCertPromiseObj, evictKey) => {
        log.info(`旧证书缓存被移除：${evictKey}`)
      },
    })
    this.caCert = caCert
    this.caKey = caKey
  }

  addCertPromise (certPromiseObj) {
    // 添加缓存
    this.cache.set(certPromiseObj.dnsName, certPromiseObj)
  }

  getCertPromise (hostname, port, dnsName, mappingHostNames) {
    // 获取缓存
    const cached = this.cache.get(dnsName)
    if (cached) {
      log.debug(`Load fakeCertPromise from cache, hostname: ${hostname}:${port}, certPromiseObj: {"mappingHostNames":${JSON.stringify(cached.mappingHostNames)}}`)
      return cached.promise
    }

    log.info(`【CreateFakeCertificate】dnsName: ${dnsName}, hostname: ${hostname}:${port}`)
    const promise = tlsUtils.createFakeCertificateByDomain(this.caKey, this.caCert, dnsName, mappingHostNames)

    const certPromiseObj = {
      dnsName,
      mappingHostNames,
      promise,
    }
    this.addCertPromise(certPromiseObj)

    // 证书生成失败时把失败的 promise 从缓存中移除，下次连接会重新生成，
    // 否则该域名在缓存命中期间会一直拿到同一个 rejected promise，永久连接失败
    promise.catch(() => {
      if (this.cache.peek(dnsName) === certPromiseObj) {
        this.cache.delete(dnsName)
      }
    })

    return promise
  }
}
