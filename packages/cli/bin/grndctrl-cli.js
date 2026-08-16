#!/usr/bin/env node
import { runCliAsync } from '../dist/index.js'

const { output, exitCode } = await runCliAsync(process.argv.slice(2))
console.log(output)
process.exit(exitCode)
