#!/usr/bin/env node

const yargs = require('yargs')
const net = require('net')
const sqlite3 = require('sqlite3').verbose()
const SQLiteTag = require('sqlite-tag')
const { subDays, startOfDay, eachDayOfInterval, format } = require('date-fns')

const sleep = (d) => new Promise((res) => setTimeout(res, d))

const getDb = async (args) => {
  const sl3 = new sqlite3.Database('./mutil.db')
  const db = SQLiteTag(sl3)

  const scrobTable = await db.get`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name = 'scrobs';
  `
  if (!scrobTable) {

    console.log('Creating scrob table')
    await db.query`
      CREATE TABLE scrobs (
        id                  INTEGER PRIMARY KEY,
        albumartist         TEXT    NOT NULL,
        album               TEXT    NOT NULL,
        title               TEXT    NOT NULL,
        duration            INTEGER DEFAULT 0 NOT NULL,
        musicbrainz_trackid TEXT,
        at                  INTEGER NOT NULL
      );
    `
  }
  
  return db
}

const _compileSvgEl = (el, parts, d) => {
  const { tag, children, ...attrs } = el
  const indent = new Array(d).fill(' ').join('')
  parts.push(indent, '<', tag)

  for (const [key, val] of Object.entries(attrs)) {
    parts.push(' ', key, '="', val, '"')
  }

  if (children) {
    parts.push('>\n')

    if (typeof children === 'string') {
      parts.push(indent, '  ', children, '\n')
    } else {
      for (const child of children) {
        _compileSvgEl(child, parts, d+1)
      }
    }

    parts.push(indent, '</', tag, '>\n')
  } else {
    parts.push(' />\n')
  }
}

const compileSVG = (svg, opts) => {
  const parts = []
  _compileSvgEl(svg, parts, 0)

  return parts.join('')
}

const svgTrans = (content, x, y) => {
  return {
    tag: 'g',
    transform: `translate(${x} ${y})`,
    children: Array.isArray(content) ? content : content
  }
}

const makeBarChart = (data, opts) => {
  const pad = opts.pad || opts.height * 0.05

  const pW = opts.width - pad * 2
  const pH = opts.height - 25 - pad * 2

  const bP = opts.barPad || 0
  const bW = (pW / data.length) - bP
  const yMax = Math.max(...data.map(d => d.value))

  const bars = data.map((datum, idx) => {
    const height = (datum.value / yMax) * pH
    return {
      tag: 'rect',
      fill: '#000',
      width: bW,
      height,
      x: idx * (bW + bP),
      y: pH - height,
    }
  })

  const labels = data.map((datum, idx) => {
    return {
      tag: 'text',
      children: datum.label,
      x: idx * (bW + bP) + (bW / 2),
      y: 0,
      'font-size': 20,
      'dominant-baseline': 'middle',
      'text-anchor': 'middle',
      'fill': '#000',
    }
  })

  return {
    tag: 'g',
    children: [
      svgTrans(bars, pad, pad),
      svgTrans(labels, pad, pad + pH + 25),
    ]
  }
}

const formatDuration = (seconds) => {
  let rSecs = seconds
  const days = ~~(rSecs / (60 * 60 * 24))
  rSecs -= days * (60 * 60 * 24)
  const hours = ~~(rSecs / (60 * 60))
  rSecs -= hours * (60 * 60)
  const minutes = ~~(rSecs / 60)
  rSecs -= minutes * 60
  return [
    [days, 'day'],
    [hours, 'hour'],
    [minutes, 'minute'],
    [rSecs, 'second']
  ]
  .filter(([v]) => !!v)
  .map(([v, l]) => `${v} ${l}${v > 1 ? 's' : ''}`)
  .join(', ')
}

const issueCmusCmd = (cmd) => {
  return new Promise((res, rej) => {
    const client = net.createConnection('/Users/ryan.jenkins/.config/cmus/socket')
    client
      .on('connect', () => {
        client.write(cmd + '\n')
      })
      .on('data', (data) => {
        client.end()
        res(data)
      })
  })
}

const getCmusStatus = async () => {
  const raw = await issueCmusCmd('status')
  const output = {}

  raw.toString().split('\n').forEach((line) => {
    const [leader, p2, ...rest] = line.split(' ')
    if (leader === 'status') output.status = p2
    else if (leader === 'duration') output.duration = +p2
    else if (leader === 'position') output.position = +p2
    else if (leader === 'tag') {
      output[p2] = rest.join(' ')
    }
  })

  return output
}

const commands = {
  cmusStatus: async (args) => {
    const status = await getCmusStatus()
    console.log(status)
  },
  scrobd: async (args) => {
    const db = await getDb(args)
    let lastTrackId = null
    let lastPollTime = Date.now()
    let playTime = 0
    let scrobd = false

    const output = (msg) => {
      if (args.term) {
        process.stdout.clearLine(0)
        process.stdout.cursorTo(0)
        process.stdout.write(msg)
      } else {
        console.log(msg)
      }
    }

    while (true) {
      const status = await getCmusStatus()
      const trackId = [
        status.albumartist || status.artist,
        status.album,
        status.title
      ].join('::')

      const timeToScrob = Math.min(240000, status.duration * 500)
      const p = status.status === 'playing' ? '\u25B6\uFE0F': '\u23F8 '
      const s = scrobd ? '✓' : ~~((playTime * 100) / timeToScrob) + '%'
      output(`${p} ${status.albumartist} - ${status.title} | ${s}`)

      if (trackId === lastTrackId && status.status === 'playing') {
        playTime += Date.now() - lastPollTime

        if (
          !scrobd &&
          (
            playTime > 240000 ||
            playTime > (status.duration * 500
          )
        )) {
          await db.query`
            INSERT INTO scrobs (
              albumartist,
              album,
              title,
              musicbrainz_trackid,
              duration,
              at
            ) VALUES (
              ${status.albumartist || status.artist},
              ${status.album},
              ${status.title},
              ${status.musicbrainz_trackid},
              ${status.duration},
              ${~~(Date.now() / 1000)}
            )
          `
          !args.term && console.log(`Scrob'd ${trackId}`)
          scrobd = true
        }
      } else if (trackId !== lastTrackId) {
        !args.term && console.log(`track changed to ${trackId}`)
        playTime = 0
        scrobd = false
      }


      lastTrackId = trackId
      lastPollTime = Date.now()

      await sleep(2000)
    }
  },
  today: async (args) => {
    const db = await getDb(args)
    const startOfDay = ~~((new Date()).setHours(0, 0, 0, 0) / 1000)
    const scrobs = await db.all`
      SELECT * FROM scrobs WHERE at > ${startOfDay};
    `

    const byAlbum = {}
    let cumTime = 0
    scrobs.forEach((scrob) => {
      cumTime += scrob.duration

      const key = `${scrob.album} - ${scrob.albumartist}`
      if (!(key in byAlbum)) byAlbum[key] = []
      byAlbum[key].push(scrob)
    })

    const topAlbums = Object.entries(byAlbum)
      .sort(([,a], [,b]) => b.length - a.length)
      .slice(0, 5)

    const report = [
      `You've scrobbled ${scrobs.length} times today.`,
      `Total listen time: ${formatDuration(cumTime)}`,
      '',
      'Top Albums:',
      ...topAlbums.map(([key, scrobs]) => `${scrobs.length}\t${key}`)
    ]

    console.log(report.join('\n'))
  },
  timeChart: async (args) => {
    const db = await getDb(args)
    const now = new Date()
    const start = startOfDay(subDays(now, 6))

    const scrobs = await db.all`
      SELECT * FROM scrobs WHERE at > ${start.valueOf() / 1000};
    `

    const counts = {}
    for (const scrob of scrobs) {
      const dow = format(new Date(scrob.at * 1000), 'E')
      counts[dow] = (counts[dow] || 0) + 1
    }

    const days = eachDayOfInterval({ start, end: now })
    const data = []
    for (const d of days) {
      const dow = format(d, 'E')
      data.push({ label: dow, value: counts[dow] || 0 })
    }

    const h = 300
    const w = 600

    const svg = {
      tag: 'svg',
      viewBox: `0 0 ${w} ${h}`,
      xmlns: 'http://www.w3.org/2000/svg',
      children: [
        makeBarChart(data, {
          width: w,
          height: h,
          barPad: 5,
        })
      ]
    }

    console.log(compileSVG(svg))
  }
}

yargs
  .scriptName('mutil')
  .command({
    command: 'cmus-status',
    describe: 'query cmus for the currently playing track',
    handler: commands.cmusStatus
  })
  .command({
    command: 'scrobd',
    describe: 'poll cmus and record scrobs',
    handler: commands.scrobd,
    builder: (yargs) => {
      yargs.option('term', {
        describe: 'write status to a single line',
        type: 'boolean',
      })
    }
  })
  .command({
    command: 'today',
    describe: 'report on today\'s scrobs',
    handler: commands.today
  })
  .command({
    command: 'time-chart',
    describe: '',
    handler: commands.timeChart
  })
  .strictCommands()
  .demandCommand(1)
  .parse(process.argv.slice(2))

