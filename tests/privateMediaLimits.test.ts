import { expect, it } from 'vitest'
import { assertRenderPixels, rasterDecodedBytes, PrivateMaterializationError } from '../shared/privateMedia.ts'

it('intrinsic animation cost charges every frame independently of display size', () => {
  expect(rasterDecodedBytes(512, 512, 64)).toBe(64 * 1024 * 1024)
  expect(() => rasterDecodedBytes(512, 512, 65)).toThrow(PrivateMaterializationError)
  expect(() => rasterDecodedBytes(1, 1, 101)).toThrow(PrivateMaterializationError)
  expect(() => rasterDecodedBytes(10_000, 10_000)).toThrow(PrivateMaterializationError)
  expect(() => rasterDecodedBytes(0, 4)).toThrow(PrivateMaterializationError)
})

it('output admission checks finite input dimensions and scaled pixel area separately', () => {
  expect(() => assertRenderPixels(2_048, 2_048, 2)).not.toThrow()
  expect(() => assertRenderPixels(2_049, 2_048, 2)).toThrow(PrivateMaterializationError)
  expect(() => assertRenderPixels(16_385, 1, 0.01)).toThrow(PrivateMaterializationError)
  expect(() => assertRenderPixels(100, 100, Infinity)).toThrow(PrivateMaterializationError)
  expect(() => assertRenderPixels(Number.NaN, 100)).toThrow(PrivateMaterializationError)
})
