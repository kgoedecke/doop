# Intrinsic image admission fixture

`compressed-100m-pixel.png` is a valid 10,000 × 10,000 grayscale PNG. Its
compressed encoding is only 97,276 bytes, but its intrinsic raster exceeds the
private renderer's pixel and decoded-byte budgets. SHA-256:
`aded73ca07c469392fea89a2243019f0d2c1d1b9a50288d3945118ecf674c827`.

It was constructed with bounded streaming zlib compression of repeated zero
scanlines. Tests must inspect metadata and prove rejection before raw decoding;
never decode its 100 million pixels to establish that it should be refused.
Small valid image controls exercise actual decoding separately.
