# Cantelop SDK artifact

`cantelop-sdk-1.0.0-alpha.5.tgz` is packed from
`../Dakar/cantelop-sdk` at commit `fae8340`, including portable backend client
declarations. Both Doop and the hosted service use this archive so clean installs
and Docker builds use the same compiler and runtime SDK.

The compiler emits `client.d.mts` beside `client.mjs`, preserving the App's
protocol types without importing native runtime dependencies. Keep the whole
generated backend directory when copying deployment artifacts.

To refresh the archive from the SDK checkout after verifying its changes:

```sh
cd ../Dakar/cantelop-sdk
pnpm build
npm pack --ignore-scripts --pack-destination ../../doop/vendor
```

Then run `bun install` and `bun install --cwd cantelop` in Doop to update both
lockfiles. Replace the archive pins with a published version once that release
includes the declaration fix.
