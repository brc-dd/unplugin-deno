import { closestString } from 'https://deno.land/std@0.224.0/text/closest_string.ts'
import './style.css'

export const values = { closest: closestString('hello', ['help', 'world']) }
