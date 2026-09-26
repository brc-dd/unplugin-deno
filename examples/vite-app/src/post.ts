import { toKebabCase } from '@std/text/to-kebab-case'
import { customAlphabet } from 'nanoid/non-secure'
import { closestString } from 'https://deno.land/std@0.224.0/text/closest_string.ts'
import topicList from './topics.txt' with { type: 'text' }

/** The topics a post can be filed under (one per line in `topics.txt`). */
export const topics: string[] = topicList
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')

const shortId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6)

/** A URL path for a post: its title in kebab case and a short random id. */
export function postPath(title: string): string {
  return `/posts/${toKebabCase(title) || 'untitled'}-${shortId()}`
}

/** The known topic closest to what was typed, so typos still find a topic. */
export function closestTopic(typed: string): string {
  return closestString(typed.trim() || topics[0]!, topics)
}
