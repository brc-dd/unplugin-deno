import { libMain } from './lib.ts'
import remoteMain from 'data:text/javascript,export default import.meta.main'

export const isMain: boolean = import.meta.main

export const values = { libMain, remoteMain }
