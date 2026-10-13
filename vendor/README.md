# Local SDK qualification artifact

`cantelop-sdk-1.0.0-alpha.3.tgz` is packed from the sibling
`../Dakar/cantelop-sdk` source checkout with configurable `createClaudeHarness`, the SDK-owned durable
`createClaudeRuntime`, its public Session protocol, compiler factory support and
structured Workspace login, code submission and cancellation methods, plus
backend-safe configuration validation and native output decoding. It includes the SDK's compiled public package only.
Both Doop dependency manifests point at this tarball so frozen installs, CI and
Docker builds consume the same tested API without copying the SDK implementation
into Doop or requiring access to a sibling repository.

The SDK source prepares alpha.3; npm publication is a separate release operation.
After publishing and qualifying alpha.3, replace both file dependency pins with
`1.0.0-alpha.3`, regenerate both Bun lockfiles, and remove this artifact and its
Dockerfile COPY entries.

To refresh it after SDK changes, run the SDK's tests, example/package qualification
and Bun checks, then pack its built distribution:

```sh
cd ../Dakar/cantelop-sdk
corepack pnpm build
npm pack --ignore-scripts --pack-destination ../../doop/vendor
```

Run `bun install` in Doop and `bun install --cwd cantelop` to refresh the locked
artifact integrity, then rerun the integration checks. Do not publish from this
application repository.
