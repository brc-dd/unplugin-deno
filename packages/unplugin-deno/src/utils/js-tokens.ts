/**
 * A small, forgiving JavaScript/TypeScript tokenizer for the source checks that must not look
 * inside strings, comments or regular expressions (docs/architecture.md §5.10): it is the fallback
 * when no parser is available (Rollup's `this.parse` reads only JavaScript). It never throws;
 * unterminated literals and comments end at the end of the input. JSX text is not understood (an
 * apostrophe in JSX text starts a string), which only makes scans miss things, never invent them
 * inside a real string or comment.
 *
 * @module
 */

/** Token kinds; comments and whitespace are skipped. */
export type TokenType = 'name' | 'private' | 'number' | 'string' | 'template' | 'regex' | 'punct'

/** One token: `value` is the decoded content of strings, the source text otherwise. */
export interface Token {
  type: TokenType
  value: string
  /** Offset of the first character (UTF-16). */
  start: number
  /** Offset after the last character. */
  end: number
}

/** Punctuators, longest first so the greedy match picks `===` over `==` over `=`. */
const PUNCTUATORS = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**',
  '<<',
  '>>',
]

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_KEYWORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'extends',
])

const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
}

const IDENTIFIER_START = /[\p{ID_Start}$_\\]/u
const IDENTIFIER_PART = /[\p{ID_Continue}$\\]|‌|‍/u

/** Splits `code` into tokens (see the module documentation). */
export function tokenize(code: string): Token[] {
  const tokens: Token[] = []
  /** `template` for a `${` substitution, `brace` for any other `{`. */
  const braces: Array<'brace' | 'template'> = []
  let index = code.startsWith('#!') ? lineEnd(code, 0) : 0
  const length = code.length
  while (index < length) {
    const char = code[index] as string
    if (isWhitespace(char)) {
      index++
      continue
    }
    const next = code[index + 1]
    if (char === '/' && next === '/') {
      index = lineEnd(code, index + 2)
      continue
    }
    if (char === '/' && next === '*') {
      const close = code.indexOf('*/', index + 2)
      index = close === -1 ? length : close + 2
      continue
    }
    if (char === '"' || char === "'") {
      const token = readString(code, index, char)
      tokens.push(token)
      index = token.end
      continue
    }
    if (char === '`') {
      index = readTemplate(code, index + 1, index, tokens, braces)
      continue
    }
    if (char === '}' && braces.at(-1) === 'template') {
      braces.pop()
      index = readTemplate(code, index + 1, index, tokens, braces)
      continue
    }
    if (isDigit(char) || (char === '.' && isDigit(next))) {
      const end = readNumber(code, index)
      tokens.push({ type: 'number', value: code.slice(index, end), start: index, end })
      index = end
      continue
    }
    if (char === '#' && next !== undefined && IDENTIFIER_START.test(next)) {
      const end = readName(code, index + 1)
      tokens.push({ type: 'private', value: code.slice(index, end), start: index, end })
      index = end
      continue
    }
    if (IDENTIFIER_START.test(char)) {
      const end = readName(code, index)
      tokens.push({ type: 'name', value: code.slice(index, end), start: index, end })
      index = end
      continue
    }
    if (char === '/' && regexAllowed(tokens.at(-1))) {
      const end = readRegex(code, index)
      if (end !== -1) {
        tokens.push({ type: 'regex', value: code.slice(index, end), start: index, end })
        index = end
        continue
      }
    }
    const punct = PUNCTUATORS.find((candidate) => code.startsWith(candidate, index)) ?? char
    // `?.5` is a conditional followed by a number, not optional chaining.
    const value = punct === '?.' && isDigit(code[index + 2]) ? '?' : punct
    if (value === '{') braces.push('brace')
    else if (value === '}') braces.pop()
    tokens.push({ type: 'punct', value, start: index, end: index + value.length })
    index += value.length
  }
  return tokens
}

/**
 * Line and column (both 1-based, the column in UTF-16 code units) of `offset` in `code`, for
 * messages.
 */
export function lineColumn(code: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let index = code.indexOf('\n'); index !== -1 && index < offset;) {
    line++
    lineStart = index + 1
    index = code.indexOf('\n', lineStart)
  }
  return { line, column: offset - lineStart + 1 }
}

function isWhitespace(char: string): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\r' ||
    char === '\f' ||
    char === '\v' ||
    char === ' ' ||
    char === '﻿' ||
    char === ' ' ||
    char === ' ' ||
    /\s/.test(char)
  )
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function lineEnd(code: string, from: number): number {
  const newline = code.indexOf('\n', from)
  return newline === -1 ? code.length : newline
}

function readName(code: string, start: number): number {
  let index = start
  while (index < code.length && IDENTIFIER_PART.test(code[index] as string)) index++
  return index
}

function readNumber(code: string, start: number): number {
  let index = start
  while (index < code.length) {
    const char = code[index] as string
    if (/[\w.]/.test(char)) index++
    else if ((char === '+' || char === '-') && /[eE]/.test(code[index - 1] ?? '')) index++
    else break
  }
  return index
}

/** A quoted string (the quote at `start`); `value` has the escapes decoded. */
function readString(code: string, start: number, quote: string): Token {
  let value = ''
  let index = start + 1
  while (index < code.length) {
    const char = code[index] as string
    if (char === quote) return { type: 'string', value, start, end: index + 1 }
    if (char === '\n') break
    if (char !== '\\') {
      value += char
      index++
      continue
    }
    const escaped = code[index + 1]
    if (escaped === undefined) {
      index++
      break
    }
    if (escaped === '\r' || escaped === '\n') {
      // A line continuation.
      index += escaped === '\r' && code[index + 2] === '\n' ? 3 : 2
      continue
    }
    const unicode = /^u\{([\da-fA-F]+)\}|^u([\da-fA-F]{4})|^x([\da-fA-F]{2})/.exec(
      code.slice(index + 1, index + 12),
    )
    if (unicode !== null) {
      const hex = unicode[1] ?? unicode[2] ?? unicode[3] ?? '0'
      value += String.fromCodePoint(Number.parseInt(hex, 16))
      index += 1 + unicode[0].length
      continue
    }
    value += ESCAPES[escaped] ?? escaped
    index += 2
  }
  return { type: 'string', value, start, end: index }
}

/**
 * A template chunk from `from` (after '`' or the `}` closing a substitution) to its closing '`' or
 * the next `${`; pushes a `template` token and returns where tokenizing continues.
 */
function readTemplate(
  code: string,
  from: number,
  start: number,
  tokens: Token[],
  braces: Array<'brace' | 'template'>,
): number {
  let index = from
  while (index < code.length) {
    const char = code[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '`') {
      tokens.push({ type: 'template', value: code.slice(start, index + 1), start, end: index + 1 })
      return index + 1
    }
    if (char === '$' && code[index + 1] === '{') {
      tokens.push({ type: 'template', value: code.slice(start, index + 2), start, end: index + 2 })
      braces.push('template')
      return index + 2
    }
    index++
  }
  tokens.push({ type: 'template', value: code.slice(start), start, end: code.length })
  return code.length
}

/** Whether a `/` after `previous` starts a regular expression. */
function regexAllowed(previous: Token | undefined): boolean {
  if (previous === undefined) return true
  switch (previous.type) {
    case 'name':
      return REGEX_AFTER_KEYWORDS.has(previous.value)
    case 'punct':
      return previous.value !== ')' && previous.value !== ']'
    case 'template':
      // After the `${` that opens a substitution.
      return previous.value.endsWith('${')
    default:
      return false
  }
}

/** The end of a regular expression literal starting at `start`, or -1 when there is none. */
function readRegex(code: string, start: number): number {
  let index = start + 1
  let inClass = false
  while (index < code.length) {
    const char = code[index]
    if (char === '\n' || char === '\r') return -1
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) {
      index++
      while (index < code.length && /[a-zA-Z]/.test(code[index] as string)) index++
      return index
    }
    index++
  }
  return -1
}
