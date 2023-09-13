import * as core from '@actions/core'
import * as cache from '@actions/cache'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { getInput } from './input'
import * as util from './util'
import { MtimeJson } from './json'
import { promisify } from 'util'
const nanoutimes = require(`../lib/node-v${process.versions.modules}-darwin-${os.arch()}/nanoutimes.node`)
const utimes = promisify(nanoutimes.utimesSync)

main()

async function main() {
  try {
    const runnerOs = process.env['RUNNER_OS']
    if (runnerOs != 'macOS') {
      throw new Error(`host is not macOS: ${runnerOs}`)
    }
    const input = getInput()
    core.info('> inputs')
    Object.entries(input).forEach(([key, value]) => {
      core.info(`${key}: ${value}`)
    })
    const tempDirectory = path.join(process.env['RUNNER_TEMP']!, 'irgaly-xcode-cache')
    const derivedDataDirectory = await input.getDerivedDataDirectory()
    await restoreDerivedData(
      derivedDataDirectory,
      tempDirectory,
      input.key,
      input.restoreKeys,
      input.verbose
    )
    const sourcePackagesDirectory = await input.getSourcePackagesDirectory()
    if (sourcePackagesDirectory == null) {
      core.info(`SourcePackages directory not found, skip restoring SourcePackages`)
    } else {
      await restoreSourcePackages(
        sourcePackagesDirectory,
        tempDirectory,
        await input.getSwiftpmCacheKey(),
        input.swiftpmCacheRestoreKeys,
        input.verbose
      )
    }
    await restoreMtime(
      derivedDataDirectory,
      input.restoreMtimeTargets,
      input.verbose
    )
    await fs.rm(tempDirectory, { recursive: true })
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

async function restoreDerivedData(
  derivedDataDirectory: string,
  tempDirectory: string,
  key: string,
  restoreKeys: string[],
  verbose: boolean
) {
  const tar = path.join(tempDirectory, 'DerivedData.tar')
  const restored = (await cache.restoreCache([tar], key, restoreKeys) != undefined)
  if (!restored) {
    core.info('DerivedData cache not found')
  } else {
    const parent = path.dirname(derivedDataDirectory)
    await fs.mkdir(parent, { recursive: true })
    let args = ['-xf', tar, '-C', path.dirname(derivedDataDirectory)]
    if (verbose) {
      args = ['-v', ...args]
    }
    core.info(['tar', ...args].join(' '))
    const output = await util.execute('tar', args)
    core.info(output)
    core.info(`DerivedData has restored from cache: ${derivedDataDirectory}`)
  }
}

async function restoreSourcePackages(
  sourcePackagesDirectory: string,
  tempDirectory: string,
  key: string,
  restoreKeys: string[],
  verbose: boolean
) {
  const tar = path.join(tempDirectory, 'SourcePackages.tar')
  const restored = (await cache.restoreCache([tar], key, restoreKeys) != undefined)
  if (!restored) {
    core.info('SourcePackages cache not found')
  } else {
    const parent = path.dirname(sourcePackagesDirectory)
    await fs.mkdir(parent, { recursive: true })
    let args = ['-xf', tar, '-C', path.dirname(sourcePackagesDirectory)]
    if (verbose) {
      args = ['-v', ...args]
    }
    core.info(['tar', ...args].join(' '))
    const output = await util.execute('tar', args)
    core.info(output)
    core.info(`SourcePackages has restored from cache: ${sourcePackagesDirectory}`)
  }
}

async function restoreMtime(
  derivedDataDirectory: string,
  restoreMtimeTargets: string[],
  verbose: boolean
) {
  try {
    let changed = 0
    let skipped: string[] = []
    const jsonFile = path.join(derivedDataDirectory, 'xcode-cache-mtime.json')
    const files = JSON.parse(await fs.readFile(jsonFile, 'utf8')) as MtimeJson[]
    core.info(`restore mtime from ${jsonFile}`)
    if (verbose) {
      core.startGroup('Restored files')
    }
    files.forEach (async item => {
      const stat = await fs.stat(item.path, {bigint: true})
      if (stat) {
        const fileMtime = stat.mtimeNs.toString()
        const cacheMtime = item.time.replace(',', '')
        if (fileMtime == cacheMtime) {
          if (verbose) {
            skipped.push(`mtime not changed : ${item.path}`)
          }
        } else {
          let sha256 = ''
          if (stat.isDirectory()) {
            sha256 = await util.calculateDirectoryHash(item.path)
          } else {
            sha256 = await util.calculateHash(item.path)
          }
          if (sha256 != item.sha256) {
            if (verbose) {
              skipped.push(`content not changed : ${item.path}`)
            }
          } else {
            if (verbose) {
              core.info(`=> ${item.time} : ${item.path}`)
            }
            const [second, nano] = item.time.split(',').map(v => { Number(v) })
            await utimes(item.path, second, nano, second, nano)
            changed++
          }
        }
      }
    })
    if (verbose) {
      core.endGroup()
    }
    if (verbose) {
      core.startGroup('Skipped files')
      skipped.forEach (v => {
        core.info(v)
      })
      core.endGroup()
    }
    core.info(`Restored ${changed} files.`)
  } catch (error) {
    if (error instanceof Error) {
      // in case fs.ReadFile(): jsonFile not found.
      core.error(error)
    }
  }
}
