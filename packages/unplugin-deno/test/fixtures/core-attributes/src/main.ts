import text from './data.txt' with { type: 'text' }
import bytes from './data.bin' with { type: 'bytes' }
import json from './data.json' with { type: 'json' }
import sheet from './style.css' with { type: 'css' }
import license from 'https://cdn.jsdelivr.net/npm/kleur@4.1.5/license' with { type: 'text' }
import licenseBytes from 'https://cdn.jsdelivr.net/npm/kleur@4.1.5/license' with { type: 'bytes' }
import packageJson from 'https://cdn.jsdelivr.net/npm/kleur@4.1.5/package.json' with { type: 'json' }
import normalize from 'https://cdn.jsdelivr.net/npm/normalize.css@8.0.1/normalize.css' with { type: 'css' }

/** A stand-in for the CSSStyleSheet the runtime may lack (tests install one when needed). */
interface SheetLike {
  readonly text?: string
}

export const values = {
  text,
  bytes: [...bytes],
  bytesType: bytes.constructor.name,
  json,
  css: (sheet as SheetLike).text,
  cssType: sheet.constructor.name,
  license: license.slice(0, 16),
  licenseLength: licenseBytes.length,
  licenseMatches: new TextDecoder().decode(licenseBytes) === license,
  remoteJsonName: packageJson.name,
  normalizeLength: ((normalize as SheetLike).text ?? '').length,
}

export async function dynamicValues(): Promise<unknown> {
  const dynamicText = await import('./data.txt', { with: { type: 'text' } })
  const dynamicBytes = await import('./data.bin', { with: { type: 'bytes' } })
  const dynamicJson = await import('./data.json', { with: { type: 'json' } })
  const dynamicCss = await import('./style.css', { with: { type: 'css' } })
  const dynamicLicense = await import('https://cdn.jsdelivr.net/npm/kleur@4.1.5/license', {
    with: { type: 'text' },
  })
  return {
    text: dynamicText.default,
    bytes: [...dynamicBytes.default],
    json: dynamicJson.default,
    css: (dynamicCss.default as SheetLike).text,
    license: dynamicLicense.default.slice(0, 16),
  }
}
