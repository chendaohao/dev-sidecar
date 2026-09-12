// const { exec } = require('node:child_process')
const net = require('node:net')
const https = require('node:https')
const _ = require('lodash')
const log = require('../../utils/util.log.server')
const config = require('./config.js')
const matchUtil = require('../../utils/util.match.js')
const { configFromFiles } = require('@docmirror/dev-sidecar/src/config/index.js')

const familyMapping = matchUtil.domainMapRegexply(configFromFiles.server.dns.familyMapping)

// const isWindows = process.platform === 'win32'

const DISABLE_TIMEOUT = 60 * 60 * 1000

class SpeedTester {
  constructor ({ hostname, port }) {
    this.dnsMap = config.getConfig().dnsMap

    this.hostname = hostname
    this.port = port || 443

    this.ready = false
    this.alive = []
    this.backupList = []

    this.testCount = 0
    this.lastReadTime = Date.now()
    this.keepCheckIntervalId = false

    this.tryTestCount = 0
    this.isTesting = false
    this.isTestingBackups = false

    this._probeIndex = 0 // 按需探测的轮转索引

    this.test() // 异步：初始化完成后先测速一次
  }

  // 按需探测：SpeedTester 未就绪时，轮转分配未失败 IP，并发请求自动分散
  pickNextForProbing () {
    // 第一轮：优先选未探测、未失败的 IP
    const fresh = this.backupList.filter(item =>
      item.status !== 'failed' && !item._probing,
    )
    if (fresh.length > 0) {
      this._probeIndex = this._probeIndex % fresh.length
      const pick = fresh[this._probeIndex]
      this._probeIndex++
      pick._probing = true
      return pick
    }
    // 第二轮：全部都在探测中，允许复用，总比回退到 DNS 缓存好
    const retry = this.backupList.filter(item => item.status !== 'failed')
    if (retry.length > 0) {
      this._probeIndex = this._probeIndex % retry.length
      return retry[this._probeIndex++]
    }
    return null
  }

  // 按需探测结果反馈：记录 IP 成败，供后续请求决策
  reportProbeResult (host, success) {
    const item = this.backupList.find(i => i.host === host)
    if (!item) {
      return
    }
    item._probing = false
    if (success) {
      item.status = 'success'
      item.time = item.time || 1
      this.alive.push(item)
    } else {
      item.status = 'failed'
    }
  }

  pickFastAliveIpObj () {
    this.touch()

    if (this.alive.length === 0) {
      if (this.backupList.length > 0 && this.tryTestCount % 10 > 0) {
        this.testBackups() // 异步
      } else if (this.tryTestCount % 10 === 0) {
        this.test() // 异步
      }
      this.tryTestCount++

      return null
    }
    return this.alive[0]
  }

  touch () {
    this.lastReadTime = Date.now()
    if (!this.keepCheckIntervalId) {
      this.startChecker()
    }
  }

  startChecker () {
    if (this.keepCheckIntervalId) {
      clearInterval(this.keepCheckIntervalId)
    }
    this.keepCheckIntervalId = setInterval(() => {
      if (Date.now() - DISABLE_TIMEOUT > this.lastReadTime) {
        // 超过很长时间没有访问，取消测试
        clearInterval(this.keepCheckIntervalId)
        this.keepCheckIntervalId = false
        return
      }
      if (this.alive.length > 0) {
        this.testBackups() // 异步
      } else {
        this.test() // 异步
      }
    }, config.getConfig().interval)
  }

  async getIpListFromDns (dnsMap) {
    const ips = {}
    const promiseList = []
    for (const dnsKey in dnsMap) {
      const dns = dnsMap[dnsKey]
      const one = this.getFromOneDns(dns).then((ipList) => {
        if (ipList && ipList.length > 0) {
          for (const ip of ipList) {
            ips[ip] = { dns: ipList.isPreSet === true ? '预设IP' : dnsKey }
          }
        }
      })
      promiseList.push(one)
    }
    await Promise.all(promiseList)

    const items = []
    for (const ip in ips) {
      items.push({ host: ip, dns: ips[ip].dns })
    }
    return items
  }

  async getFromOneDns (dns) {
    const family = Number.parseInt(matchUtil.matchHostname(familyMapping, this.hostname, 'get family')) === 6 ? 6 : 4
    return await dns._lookupWithPreSetIpList(this.hostname, { family })
  }

  async test () {
    if (this.isTesting) {
      log.debug(`[speed] test skipped (already running): ${this.hostname}`)
      return
    }
    this.isTesting = true
    this.testCount++
    log.debug(`[speed] test start: ${this.hostname}, testCount: ${this.testCount}`)

    try {
      const newList = await this.getIpListFromDns(this.dnsMap)
      const newBackupList = [...newList, ...this.backupList]
      this.backupList = _.unionBy(newBackupList, 'host')
      await this.testBackups()
      log.info(`[speed] test end: ${this.hostname} ➜ ip-list:`, this.backupList, `, testCount: ${this.testCount}`)
      if (config.notify) {
        config.notify({ key: 'test' })
      }
    } catch (e) {
      log.error(`[speed] test failed: ${this.hostname}, testCount: ${this.testCount}, error:`, e)
    } finally {
      this.isTesting = false
    }
  }

  async testBackups () {
    if (this.isTestingBackups) {
      log.debug(`[speed] testBackups skipped (already running): ${this.hostname}`)
      return
    }
    this.isTestingBackups = true

    try {
      if (this.backupList.length > 0) {
        const aliveList = []

        const testAll = []
        for (const item of this.backupList) {
          testAll.push(this._doTest(item, aliveList))
        }
        await Promise.all(testAll)

        // 全部测速完成后，根据耗时进行排序
        aliveList.sort((a, b) => a.time - b.time)
        this.backupList.sort((a, b) => {
          if (a.time === b.time) {
            return 0
          }
          if (a.time == null) {
            return 1
          }
          if (b.time == null) {
            return -1
          }
          return a.time - b.time
        })

        this.alive = aliveList
      }

      this.ready = true
    } finally {
      this.isTestingBackups = false
    }
  }

  async _doTest (item, aliveList) {
    try {
      const ret = await this.testOne(item)
      item.title = `${ret.by}测速成功：${ret.target}`
      log.info(`[speed] test success: ${this.hostname} ➜ ${item.host}:${this.port} from DNS '${item.dns}'`)
      _.merge(item, ret)
      aliveList.push({ ...ret, ...item })
    } catch (e) {
      if (item.time == null) {
        item.title = e.message
        item.status = 'failed'
      }
      if (!e.message.includes('timeout')) {
        log.warn(`[speed] test error:   ${this.hostname} ➜ ${item.host}:${this.port} from DNS '${item.dns}', errorMsg: ${e.message}`)
      }
    }
  }

  testByTCP (item) {
    return new Promise((resolve, reject) => {
      const { host, dns } = item
      const startTime = Date.now()

      let isOver = false
      const timeout = 5000
      let timeoutId = null

      const client = net.createConnection({ host, port: this.port, family: host.includes(':') ? 6 : 4 }, () => {
        isOver = true
        clearTimeout(timeoutId)

        const connectionTime = Date.now()
        resolve({ status: 'success', by: 'TCP', target: `${host}:${this.port}`, time: connectionTime - startTime })
        client.end()
      })
      client.on('error', (e) => {
        isOver = true
        clearTimeout(timeoutId)

        log.warn('[speed] test by TCP error:  ', this.hostname, `➜ ${host}:${this.port} from DNS '${dns}', cost: ${Date.now() - startTime} ms, errorMsg:`, e.message)
        reject(e)
        client.destroy()
      })

      timeoutId = setTimeout(() => {
        if (!isOver) {
          isOver = true
          log.warn('[speed] test by TCP timeout:', this.hostname, `➜ ${host}:${this.port} from DNS '${dns}', cost: ${Date.now() - startTime} ms`)
          reject(new Error('timeout'))
          client.destroy()
        }
      }, timeout)
    })
  }

  // 暂不使用
  // testByPing (item) {
  //   return new Promise((resolve, reject) => {
  //     const { host, dns } = item
  //     const startTime = Date.now()
  //
  //     // 设置超时程序
  //     let isOver = false
  //     const timeout = 5000
  //     const timeoutId = setTimeout(() => {
  //       if (!isOver) {
  //         log.warn('[speed] test by PING timeout:', this.hostname, `➜ ${host} from DNS '${dns}', cost: ${Date.now() - startTime} ms`)
  //         reject(new Error('timeout'))
  //       }
  //     }, timeout)
  //
  //     // 协议选择（如强制ping6）
  //     const usePing6 = !isWindows && host.includes(':') // Windows无ping6命令
  //     const cmd = usePing6
  //       ? `ping6 -c 2 ${host}`
  //       : isWindows
  //         ? `ping -n 2 ${host}`
  //         : `ping -c 2 ${host}`
  //
  //     log.debug('[speed] test by PING start:', this.hostname, `➜ ${host} from DNS '${dns}'`)
  //     exec(cmd, (error, stdout, _stderr) => {
  //       isOver = true
  //       clearTimeout(timeoutId)
  //
  //       if (error) {
  //         log.warn('[speed] test by PING error:', this.hostname, `➜ ${host} from DNS '${dns}', cost: ${Date.now() - startTime} ms, error: 目标不可达或超时`)
  //         reject(new Error('目标不可达或超时'))
  //         return
  //       }
  //
  //       // 提取延迟数据（正则匹配）
  //       const regex = /[=<](\d+(?:\.\d*)?)ms/gi // 适配Linux/Windows
  //       const times = []
  //       let match
  //       // eslint-disable-next-line no-cond-assign
  //       while ((match = regex.exec(stdout)) !== null) {
  //         times.push(Number.parseFloat(match[1]))
  //       }
  //
  //       if (times.length === 0) {
  //         log.warn('[speed] test by PING error:', this.hostname, `➜ ${host} from DNS '${dns}', cost: ${Date.now() - startTime} ms, error: 无法解析延迟`)
  //         reject(new Error('无法解析延迟'))
  //       } else {
  //         // 计算平均延迟
  //         const avg = times.reduce((a, b) => a + b, 0) / times.length
  //         resolve({ status: 'success', by: 'PING', target: host, time: Math.round(avg) })
  //       }
  //     })
  //   })
  // }

  // 通过真实TLS握手 + HTTP请求测速（SNI使用真实域名，与实际请求一致）
  // 作用：识别"TCP能通但TLS被阻断/限速"的假存活IP，这类IP用纯TCP测速会误判为可用
  testByTLSHTTP (item) {
    return new Promise((resolve, reject) => {
      const { host, dns } = item
      const startTime = Date.now()

      let isOver = false
      const timeout = 8000
      let timeoutId = null
      let req = null

      const fail = (e) => {
        if (isOver) {
          return
        }
        isOver = true
        clearTimeout(timeoutId)
        if (!e.message.includes('timeout')) {
          log.warn('[speed] test by TLS error:  ', this.hostname, `➜ ${host}:${this.port} from DNS '${dns}', cost: ${Date.now() - startTime} ms, errorMsg:`, e.message)
        } else {
          log.warn('[speed] test by TLS timeout:', this.hostname, `➜ ${host}:${this.port} from DNS '${dns}', cost: ${Date.now() - startTime} ms`)
        }
        req.destroy()
        reject(e)
      }

      req = https.request({
        host,
        port: this.port,
        servername: this.hostname, // 关键：SNI用真实域名，模拟客户端真实握手
        path: '/robots.txt',
        method: 'HEAD',
        family: host.includes(':') ? 6 : 4,
        rejectUnauthorized: false, // 测速只关心连通性与耗时，不校验证书
      }, (res) => {
        if (isOver) {
          res.destroy()
          return
        }
        isOver = true
        clearTimeout(timeoutId)
        const ttfb = Date.now() - startTime
        resolve({ status: 'success', by: 'TLS', target: `${host}:${this.port}`, time: ttfb, tlsTime: item.tlsTime })
        req.destroy()
        res.destroy()
      })
      req.on('socket', (socket) => {
        socket.once('secureConnect', () => {
          item.tlsTime = Date.now() - startTime
        })
      })
      req.on('error', e => fail(e))
      timeoutId = setTimeout(() => fail(new Error('timeout')), timeout)
      req.end()
    })
  }

  testOne (item) {
    // 非HTTPS端口无法做TLS测速，仍用TCP测速
    if (Number.parseInt(this.port) !== 443) {
      return this.testByTCP(item)
    }
    return new Promise((resolve, reject) => {
      // 用TLS+HTTP测速代替纯TCP测速：TLS握手失败或无响应的IP直接判定为不可用，
      // 避免"TCP测速通过、实际请求全部卡死在TLS阶段"的假存活IP被选中
      this.testByTLSHTTP(item)
        .then(resolve)
        .catch((e) => {
          reject(new Error(`TLS/HTTP测速失败：${item.host}:${this.port} ${e.message}`))
        })
    })
  }
}

module.exports = SpeedTester
