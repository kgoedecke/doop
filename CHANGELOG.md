# Changelog

## [0.9.0](https://github.com/kgoedecke/doop/compare/v0.8.0...v0.9.0) (2026-10-21)


### Features

* **agents:** dock the "Design it" composer in the agents tab instead of a floating bar ([#277](https://github.com/kgoedecke/doop/issues/277)) ([361ada6](https://github.com/kgoedecke/doop/commit/361ada6abbea29709634c68d58691d58adb97e4b))
* **auth:** land social and SSO signups on their first canvas ([#245](https://github.com/kgoedecke/doop/issues/245)) ([c32df65](https://github.com/kgoedecke/doop/commit/c32df6571e7bdebbcc40331ad4848a752d1aa8b9))
* **auth:** sign in with Apple on the web and natively on iOS ([#263](https://github.com/kgoedecke/doop/issues/263)) ([8397b1e](https://github.com/kgoedecke/doop/commit/8397b1eb6171d7c9a2a54e9bdd18ca9751cee957))
* **canvas:** ⌘. hides all panels and toolbars, Figma-style ([#274](https://github.com/kgoedecke/doop/issues/274)) ([8fb92e5](https://github.com/kgoedecke/doop/commit/8fb92e55904dd7506f46c248c9245e804b97d0ec))
* **canvas:** add drawing tools to the bottom toolbar ([#292](https://github.com/kgoedecke/doop/issues/292)) ([9a771f5](https://github.com/kgoedecke/doop/commit/9a771f58cd6d9f60bad1ef837c4efbe0c8fd3a72))
* **canvas:** bottom toolbar with select, hand and comment tools ([#275](https://github.com/kgoedecke/doop/issues/275)) ([210525a](https://github.com/kgoedecke/doop/commit/210525ab70a535164c6b0759e3afd79285711a6e))
* **canvas:** draw Bézier curves and move elements between frames ([#293](https://github.com/kgoedecke/doop/issues/293)) ([b611204](https://github.com/kgoedecke/doop/commit/b6112043749d61771130f099e07b3338b0588c97))
* **canvas:** replace chat with a comments panel and drop the chat data model ([#272](https://github.com/kgoedecke/doop/issues/272)) ([abe2fa5](https://github.com/kgoedecke/doop/commit/abe2fa53c67bba80f1b3610baeaab4743d0685bf))
* **canvas:** snap and edit vector path anchors ([#295](https://github.com/kgoedecke/doop/issues/295)) ([7e24f96](https://github.com/kgoedecke/doop/commit/7e24f96df4b420324c678d4263adf596a080f185))
* **canvas:** zoom controls move to the bottom-right with a zoom menu on the percentage ([#271](https://github.com/kgoedecke/doop/issues/271)) ([5058e61](https://github.com/kgoedecke/doop/commit/5058e61341e170213a4cf45001b1137285930d69))
* **claude:** add direct connector setup and desktop extension ([#280](https://github.com/kgoedecke/doop/issues/280)) ([d058f12](https://github.com/kgoedecke/doop/commit/d058f123b831949725f87654148401b0d1cc1301))
* **comments:** comment cursor and comments anywhere on the canvas ([#290](https://github.com/kgoedecke/doop/issues/290)) ([a880ff8](https://github.com/kgoedecke/doop/commit/a880ff822a59f579bd1dbabf45735bbab31e2669))
* **connect:** add Cursor plugin and ChatGPT setup ([#281](https://github.com/kgoedecke/doop/issues/281)) ([1881b5e](https://github.com/kgoedecke/doop/commit/1881b5e82d295f154a2aa1e355e7a7f5372ce529))
* **desktop:** add automatic Codex MCP setup ([#289](https://github.com/kgoedecke/doop/issues/289)) ([3b5b090](https://github.com/kgoedecke/doop/commit/3b5b0906a932d1381c713ca9b7fb020553151ea5))
* **editor:** getting-started panel sits bottom left of the canvas ([#306](https://github.com/kgoedecke/doop/issues/306)) ([83f2f95](https://github.com/kgoedecke/doop/commit/83f2f955a1f2f506ba0f762b6ae2a340fedc61b5))
* **editor:** help button in the side rail with Docs and Contact support ([c77801f](https://github.com/kgoedecke/doop/commit/c77801f9af2e66b549130c806c72577bcd6bc8c7))
* **editor:** the tool rail's active fill slides between tools ([#303](https://github.com/kgoedecke/doop/issues/303)) ([9abe6b3](https://github.com/kgoedecke/doop/commit/9abe6b38f6e04fa7814f5095d09d04813ba1cdba))
* **editor:** white design system refresh for the canvas editor ([#300](https://github.com/kgoedecke/doop/issues/300)) ([8dc2269](https://github.com/kgoedecke/doop/commit/8dc226974dd18f5a7f287d93def47da2111e7120))
* **frames:** add frame version history with restore ([#258](https://github.com/kgoedecke/doop/issues/258)) ([a30bb35](https://github.com/kgoedecke/doop/commit/a30bb35ed37cda872e3215f4fb34a8898ed8a102))
* **home:** new home with prompt composer, shared rail and canvas tiles ([#307](https://github.com/kgoedecke/doop/issues/307)) ([ba97429](https://github.com/kgoedecke/doop/commit/ba97429662cb148e6377dfc4356fe8174a87a617))
* **ios:** lighter dark canvas and selection-scoped prompts ([c2db870](https://github.com/kgoedecke/doop/commit/c2db870afa61dfddc5db253723c9d3c5364af139))
* **ios:** sign in with Google, Microsoft and SSO ([#259](https://github.com/kgoedecke/doop/issues/259)) ([2958a9c](https://github.com/kgoedecke/doop/commit/2958a9c8e039e78a0d464da7724d8e7e11ecfbdb))
* **ios:** snap dragged frames to alignment guides ([#257](https://github.com/kgoedecke/doop/issues/257)) ([4c28b38](https://github.com/kgoedecke/doop/commit/4c28b38a8814815d8df641badef23491a922d325))
* **layers:** a Layers header like the right-hand panel ([#291](https://github.com/kgoedecke/doop/issues/291)) ([b31f7e0](https://github.com/kgoedecke/doop/commit/b31f7e06ba37896de684cb035850fefee8253269))
* **layers:** eye toggle to hide frames and layers from the layers panel ([#276](https://github.com/kgoedecke/doop/issues/276)) ([e829182](https://github.com/kgoedecke/doop/commit/e82918226458d0eb6ea75368c6995c48e40341c7))
* **layers:** lock frames and layers ([#278](https://github.com/kgoedecke/doop/issues/278)) ([cd0b827](https://github.com/kgoedecke/doop/commit/cd0b827777ac2054abdc7d8db334aa1699484821))
* **layers:** pages above frames, search at the bottom, no hints or counter ([#288](https://github.com/kgoedecke/doop/issues/288)) ([de4390c](https://github.com/kgoedecke/doop/commit/de4390c0e80e697d90c12e1849f97c7c04c63e1b))
* **mcp:** make Doop a ChatGPT app with an inline frame preview card ([#264](https://github.com/kgoedecke/doop/issues/264)) ([35579dd](https://github.com/kgoedecke/doop/commit/35579dd3f753797a05aa2c0f9c769aee56117578))
* **pages:** duplicate page from the context menu ([#273](https://github.com/kgoedecke/doop/issues/273)) ([ad62ebd](https://github.com/kgoedecke/doop/commit/ad62ebdb380e5bc5d58f624f706bc9bb17e92213))
* **panel:** icon tabs in the side panel, the active one unfolds its label ([#284](https://github.com/kgoedecke/doop/issues/284)) ([8251a12](https://github.com/kgoedecke/doop/commit/8251a12f94da8951607794863ec494e7c3a7776a))
* **slack:** add the Doop Slack agent ([#256](https://github.com/kgoedecke/doop/issues/256)) ([8a54d79](https://github.com/kgoedecke/doop/commit/8a54d7971a7f1c8d34fe7c9dd199d60d61a1ec05))
* **ui:** component layer for every dashboard screen ([#325](https://github.com/kgoedecke/doop/issues/325)) ([07af1be](https://github.com/kgoedecke/doop/commit/07af1be3562b21eabcd9470f0ec5f03521469e9b))
* **ui:** component layer for the dashboard chrome ([03b2599](https://github.com/kgoedecke/doop/commit/03b259945c980d3aa4bd431cc8405fc897a8b1ae))
* **ui:** modals open over 250ms from 96% and close over 150ms ([#304](https://github.com/kgoedecke/doop/issues/304)) ([9bcf1ec](https://github.com/kgoedecke/doop/commit/9bcf1ec16e8b5164a21facdd52003fc909eb305d))
* **ui:** named type scale and corner shapes in the design system ([#308](https://github.com/kgoedecke/doop/issues/308)) ([0a5a78e](https://github.com/kgoedecke/doop/commit/0a5a78efe95c5ae43c50b601f80de66004504efb))
* **ui:** quieter modal chrome ([#305](https://github.com/kgoedecke/doop/issues/305)) ([408050d](https://github.com/kgoedecke/doop/commit/408050db3aade3f7d77899b4075f5a531d1b3095))
* **ui:** storybook catalogue of the design system ([cb6d3d6](https://github.com/kgoedecke/doop/commit/cb6d3d68ab0f633be8e153db1bee3aaf694106c7))


### Bug Fixes

* **agents:** refuse and stop work for a banned installer ([0d087c6](https://github.com/kgoedecke/doop/commit/0d087c6946623b74bcadd065ec7fe289776956c0))
* **agents:** time a run out from dispatch, not from the request's arrival ([faf4528](https://github.com/kgoedecke/doop/commit/faf45285d4b7e7c83084ad75ab6ed9daf861fed7))
* **auth:** disconnect the Slack and Linear agents when an account is deleted ([63139ed](https://github.com/kgoedecke/doop/commit/63139ed8b213dcb483ac2355c7086ea9e5945066))
* **build:** resolve Claude extension dependencies under Bun ([#283](https://github.com/kgoedecke/doop/issues/283)) ([a4c54d5](https://github.com/kgoedecke/doop/commit/a4c54d5533b2a193be629a528ccb9cd3846723e6))
* **canvas:** carry body attributes into the frame runtime ([#326](https://github.com/kgoedecke/doop/issues/326)) ([e56ac62](https://github.com/kgoedecke/doop/commit/e56ac625f1e2392adce364e880e85653a9167376))
* **canvas:** crisp-render zoom keeps a frame's viewport units intact ([#329](https://github.com/kgoedecke/doop/issues/329)) ([23e4e06](https://github.com/kgoedecke/doop/commit/23e4e06c9763f259c138b1cfceffb0997d2a7057))
* **canvas:** keep contact support chat open ([#328](https://github.com/kgoedecke/doop/issues/328)) ([f097917](https://github.com/kgoedecke/doop/commit/f0979178acb74553a6e4e0c2d16b9cb031a15ba5))
* **canvas:** slim path editing guides and handles ([#296](https://github.com/kgoedecke/doop/issues/296)) ([6e155c9](https://github.com/kgoedecke/doop/commit/6e155c938fbbfbb8771ae063747b877e9f0454d0))
* **canvas:** the Select tool keeps the arrow cursor over frames ([#287](https://github.com/kgoedecke/doop/issues/287)) ([2c35f3c](https://github.com/kgoedecke/doop/commit/2c35f3ca80f513a9f09af227e8c0149519338769))
* **chatgpt:** no blank card on create_frame, placeholder for empty frames ([#267](https://github.com/kgoedecke/doop/issues/267)) ([83b96a0](https://github.com/kgoedecke/doop/commit/83b96a0fefc453ee4c1d1cfe10069a43774f981c))
* **comments:** the comment UI keeps its screen size at every zoom ([#286](https://github.com/kgoedecke/doop/issues/286)) ([fc3005f](https://github.com/kgoedecke/doop/commit/fc3005f21d7e4d2c657348b31059d06112959bd5))
* **editor:** no names on layer rows, even gap in the online pill ([43cb94a](https://github.com/kgoedecke/doop/commit/43cb94ae5ee6b9a57ccb64883f776e52c84bab45))
* **editor:** no tooltips on the layer row eye and lock ([5310393](https://github.com/kgoedecke/doop/commit/53103931963c534ba72a35eb78143566690ad61d))
* **editor:** support chat bubble stays off the canvas editor ([a13eb55](https://github.com/kgoedecke/doop/commit/a13eb5562c0af99685fb582fb48f81048d0786fa))
* **ios:** hold the pinch anchor when a finger lifts and snap borders at every zoom ([#262](https://github.com/kgoedecke/doop/issues/262)) ([2758f4b](https://github.com/kgoedecke/doop/commit/2758f4be4429824d331813ef43aca2a75849703b))
* **ios:** stop false connection interruption loops ([#268](https://github.com/kgoedecke/doop/issues/268)) ([89fd9b1](https://github.com/kgoedecke/doop/commit/89fd9b1d32e1a1a9a13b24223650bc1bf4c03e96))
* **mcp:** prime the screenshot cache from a frame snapshot ([9209c89](https://github.com/kgoedecke/doop/commit/9209c89c651c5686895dded792ab03f69baabc6a))
* **pages:** page rename input text was invisible in light mode ([#270](https://github.com/kgoedecke/doop/issues/270)) ([ed23d23](https://github.com/kgoedecke/doop/commit/ed23d230c926e17e422ef0b2d768f4e538307824))
* **slack:** join an early follow-up to the thread's first request ([1e85e62](https://github.com/kgoedecke/doop/commit/1e85e6282ac6387d3fd730e517fe2f4d17ce53aa))
* **tests:** keep the test harness off the live PostHog project ([#327](https://github.com/kgoedecke/doop/issues/327)) ([0afa052](https://github.com/kgoedecke/doop/commit/0afa05269f2bfda1b5e76ad34de39f5aef17571f))
* **ui:** phone dashboard opens the rail as a drawer ([#313](https://github.com/kgoedecke/doop/issues/313)) ([38e45fe](https://github.com/kgoedecke/doop/commit/38e45fe450a89b6f4da03c4bdb83c7af44905a7c))

## [0.8.0](https://github.com/kgoedecke/doop/compare/v0.7.0...v0.8.0) (2026-10-13)


### Features

* **canvas:** add named pages within canvases ([#235](https://github.com/kgoedecke/doop/issues/235)) ([0e3484c](https://github.com/kgoedecke/doop/commit/0e3484cfcbb8f60b17ffcb188a6dbe16590f0a48))
* **comments:** email collaborators about new comments and replies ([e402606](https://github.com/kgoedecke/doop/commit/e402606987c4f1c3e267679753155485c41af107))
* **connect:** pick the agent first in Connect AI, nudge to connect a plan from the prompt bar ([#226](https://github.com/kgoedecke/doop/issues/226)) ([aa1442b](https://github.com/kgoedecke/doop/commit/aa1442bc9aa3e836fbe6025e6ad3ad85461e9c70))
* **ios:** add native app with agent status and Live Activities ([#173](https://github.com/kgoedecke/doop/issues/173)) ([94afcd7](https://github.com/kgoedecke/doop/commit/94afcd75b12de12c9fab84898b8716fdfb010453))
* **ios:** end Live Activities as soon as the app sees the task is over ([#243](https://github.com/kgoedecke/doop/issues/243)) ([6f1aabf](https://github.com/kgoedecke/doop/commit/6f1aabf4316167bc0502f8e165ca3b09a0c4e56d))
* **ios:** redesign Live Activity with doop logo and step log ([#241](https://github.com/kgoedecke/doop/issues/241)) ([fa2a02a](https://github.com/kgoedecke/doop/commit/fa2a02a71c8afc4eafa5bfecc6ebe4e6385321e0))
* **server:** make per-tool rate limits configurable via env vars ([#176](https://github.com/kgoedecke/doop/issues/176)) ([a7322df](https://github.com/kgoedecke/doop/commit/a7322df187e338007efdc7c067fc53329264f66b))
* **ui:** dark mode with theme tokens, zero-flash boot and contrast fixes ([#164](https://github.com/kgoedecke/doop/issues/164)) ([1a3c3a6](https://github.com/kgoedecke/doop/commit/1a3c3a6678d88e30d3359a305bdcd64fd2fee625))
* **webhooks:** add per-user outbound webhooks for canvas events ([#230](https://github.com/kgoedecke/doop/issues/230)) ([74df768](https://github.com/kgoedecke/doop/commit/74df76835554593a7dd2f7b7e583c232e21ba863))


### Bug Fixes

* **agent:** recover interrupted model streams ([#223](https://github.com/kgoedecke/doop/issues/223)) ([67ee169](https://github.com/kgoedecke/doop/commit/67ee169b431859774b3a186bdbde49f233c373a2))
* **identity:** keep one client id when localStorage writes throw ([a939c69](https://github.com/kgoedecke/doop/commit/a939c690f2787f1beb61c272b144808f7c3e5cdb))
* **integrations:** stop the Linear tile shrinking in Safari ([#227](https://github.com/kgoedecke/doop/issues/227)) ([e1f3861](https://github.com/kgoedecke/doop/commit/e1f3861d6af6bf6b7a06b476b2cb67bc5e4cf8d1))
* **ios:** only reconcile activities open before the fetch ([1e9136d](https://github.com/kgoedecke/doop/commit/1e9136dc0a837452821c837c0ea6cd7c9d140fb8))
* **ios:** pick the APNs environment from the provisioning profile ([#237](https://github.com/kgoedecke/doop/issues/237)) ([32f62a2](https://github.com/kgoedecke/doop/commit/32f62a25f95672107529c4db1ab94a9255a50df3))
* **live-activities:** log every push outcome ([#240](https://github.com/kgoedecke/doop/issues/240)) ([9036777](https://github.com/kgoedecke/doop/commit/90367770441e8f8649b83135e40ba603518e755f))
* **live-activities:** log registration requests ahead of auth ([#238](https://github.com/kgoedecke/doop/issues/238)) ([ce76cb7](https://github.com/kgoedecke/doop/commit/ce76cb75dd4a93ea00f428c1b05834db4e18170b))
* **live-activities:** register push-to-start tokens on their own route ([#236](https://github.com/kgoedecke/doop/issues/236)) ([5be9651](https://github.com/kgoedecke/doop/commit/5be9651b0880a5a79a179ba10f599f4425e5ab92))
* **pages:** rehome frames whose page is gone on boot ([178dff9](https://github.com/kgoedecke/doop/commit/178dff9100ddb9b244ae94423b5a91e9ee435f7d))
* **ui:** use theme colors in element action popover ([1c20765](https://github.com/kgoedecke/doop/commit/1c2076529fc583a803f9becf0548b694509b18aa))

## [0.7.0](https://github.com/kgoedecke/doop/compare/v0.6.0...v0.7.0) (2026-10-01)


### Features

* **agent:** add an opt-in Gemini cloud worker prototype ([#220](https://github.com/kgoedecke/doop/issues/220)) ([f154e92](https://github.com/kgoedecke/doop/commit/f154e929566c8522edbf8e4e7cee7e21822404ba))
* **agents:** support OpenRouter and Gemini model accounts and an image-model registry ([#211](https://github.com/kgoedecke/doop/issues/211)) ([3253e88](https://github.com/kgoedecke/doop/commit/3253e885f27af81910957c4ed9c5bd964d72a10d))
* **canvas:** export progress toast and desktop save panel for exports ([#221](https://github.com/kgoedecke/doop/issues/221)) ([34b65ca](https://github.com/kgoedecke/doop/commit/34b65cac24ba43a29e1b24e3cdc85c7fed116d0d))
* **canvas:** move frame export options into a modal ([#219](https://github.com/kgoedecke/doop/issues/219)) ([aa6cb82](https://github.com/kgoedecke/doop/commit/aa6cb821f4b2cd84190dda473c88033dfc2359dc))
* **canvas:** per-canvas chat with [@mentions](https://github.com/mentions) that assign agents ([#197](https://github.com/kgoedecke/doop/issues/197)) ([2c4f077](https://github.com/kgoedecke/doop/commit/2c4f077f4fe3cd5b0eeb4912d087e8dd0ad81cb6))
* **canvas:** redesign the import modal as a source picker with one screen per source ([#208](https://github.com/kgoedecke/doop/issues/208)) ([e5eaafb](https://github.com/kgoedecke/doop/commit/e5eaafbe8777312063c4bb4ebdbd403c8956f5da))
* **linear:** run Doop designs from delegated linear tickets ([#214](https://github.com/kgoedecke/doop/issues/214)) ([44c32ac](https://github.com/kgoedecke/doop/commit/44c32aca25d9cb051dc64a218f77100b987d6ed4))
* **mcp:** agent keys for headless MCP clients (bearer auth) ([#213](https://github.com/kgoedecke/doop/issues/213)) ([33379d4](https://github.com/kgoedecke/doop/commit/33379d46451b66f038e07b7784e4cdb0ed4e0086))


### Bug Fixes

* **agents:** drop the hover-only 'Not available' label on task rows ([#200](https://github.com/kgoedecke/doop/issues/200)) ([fbfdd9a](https://github.com/kgoedecke/doop/commit/fbfdd9af5f210d2d2bf62b55577dfda20d9d2997))
* **canvas:** drop icons from import screen primary actions ([#215](https://github.com/kgoedecke/doop/issues/215)) ([510a2da](https://github.com/kgoedecke/doop/commit/510a2da7e60d6a766ea7a23515f0e6ea2e673713))
* **canvas:** keep a followed avatar's colour under the follow halo ([#162](https://github.com/kgoedecke/doop/issues/162)) ([77cb306](https://github.com/kgoedecke/doop/commit/77cb306aad47b9c901979c9d246105958458d7fb))
* land a new frame in the middle of the current view ([#165](https://github.com/kgoedecke/doop/issues/165)) ([d540e7e](https://github.com/kgoedecke/doop/commit/d540e7e1a1d6199973abc7306fc7b226c176d1ca))
* **linear:** simplify integration card and use official logo ([#222](https://github.com/kgoedecke/doop/issues/222)) ([f08782c](https://github.com/kgoedecke/doop/commit/f08782cac64ddd4c42fc1fa9563a2f66fda1416a))
* **server:** bump undici to 8.x to stop an uncatchable parser crash ([#198](https://github.com/kgoedecke/doop/issues/198)) ([894b1a2](https://github.com/kgoedecke/doop/commit/894b1a2c2da2593c3474479932af5507d7ba7a2a))

## [0.6.0](https://github.com/kgoedecke/doop/compare/v0.5.0...v0.6.0) (2026-09-19)


### Features

* **agent:** add Claude CLI and API key providers ([#155](https://github.com/kgoedecke/doop/issues/155)) ([4bed23d](https://github.com/kgoedecke/doop/commit/4bed23da489bcb5345e483015c791b51ff30c81e))
* **agent:** add GPT-6 Astra to the OpenAI model menu ([#190](https://github.com/kgoedecke/doop/issues/190)) ([31123df](https://github.com/kgoedecke/doop/commit/31123dfcbfb6dfa3d2770eaaec14eed67f33f186))
* **canvas:** locate and follow collaborators from task rows and avatars ([#191](https://github.com/kgoedecke/doop/issues/191)) ([876abcf](https://github.com/kgoedecke/doop/commit/876abcf894981f86fa8c67f9bfd3905fc6d5e649))


### Bug Fixes

* **canvas:** keep frame title labels from stealing clicks at low zoom ([#193](https://github.com/kgoedecke/doop/issues/193)) ([3a5df79](https://github.com/kgoedecke/doop/commit/3a5df790acc565fe44ced06443c461d0b3dfc34e))
* **canvas:** snap duplicate-drags to guides and let ⌫ delete the picked element ([#187](https://github.com/kgoedecke/doop/issues/187)) ([08c9fe7](https://github.com/kgoedecke/doop/commit/08c9fe776c712bf9bf141ed281305c3f8b1b56c4))
* close the socket with a clear code when a canvas does not exist ([#154](https://github.com/kgoedecke/doop/issues/154)) ([39f037e](https://github.com/kgoedecke/doop/commit/39f037ed4e484ae2781c484f0f45c69b5ed6c725)), closes [#73](https://github.com/kgoedecke/doop/issues/73)
* **db:** renumber the local-agent migration to 0017 behind task_frames ([a4cc4bb](https://github.com/kgoedecke/doop/commit/a4cc4bbc72363694fa77d33125fb5047f97ba95f))
* one-click copy button for the frame's HTML code ([#148](https://github.com/kgoedecke/doop/issues/148)) ([2230a8b](https://github.com/kgoedecke/doop/commit/2230a8bd6435a7a357c5544cb9506903e4df4836))


### Documentation

* **agents:** teach agents to generate hero backgrounds ([90853e8](https://github.com/kgoedecke/doop/commit/90853e8277e03befc4edb880fa7853416fa9d62c))

## [0.5.0](https://github.com/kgoedecke/doop/compare/v0.4.0...v0.5.0) (2026-09-16)


### Features

* **agents:** generate_image tool draws with AI on the user's own account ([#165](https://github.com/kgoedecke/doop/issues/165)) ([ad55317](https://github.com/kgoedecke/doop/commit/ad553177f327b468c84a6c111474f70bda13c0d5))
* **automations:** scheduled pulls and agent tasks, with a Meta integration ([#168](https://github.com/kgoedecke/doop/issues/168)) ([ce34ba6](https://github.com/kgoedecke/doop/commit/ce34ba67df715c2ed32e1de4ddc66e72041534f0))
* **canvas:** element properties panel opens from a click on the canvas ([#167](https://github.com/kgoedecke/doop/issues/167)) ([510fdfe](https://github.com/kgoedecke/doop/commit/510fdfecb0d5214ede2dcfd787c9e5f342fddcb7))
* **canvas:** prompt bar scopes a request to the selected frame or element ([#180](https://github.com/kgoedecke/doop/issues/180)) ([ba36d77](https://github.com/kgoedecke/doop/commit/ba36d77494e0c9f2ae7bf62ff8830697897aebe8))
* **canvas:** reorder elements in the Layers panel ([#164](https://github.com/kgoedecke/doop/issues/164)) ([fbc831e](https://github.com/kgoedecke/doop/commit/fbc831ef05264c5f3bbd6cc7ac310bf897d69447))
* **desktop:** google, microsoft and sso sign-in through the system browser with a doop:// handoff ([#177](https://github.com/kgoedecke/doop/issues/177)) ([5b51765](https://github.com/kgoedecke/doop/commit/5b517654bdada4d41820f51f04037fd24bfaa501))
* **mcp:** reply to and resolve element comments ([#150](https://github.com/kgoedecke/doop/issues/150)) ([775fd2e](https://github.com/kgoedecke/doop/commit/775fd2e6e222ab0a4cb197cb14fb70699d0f5a80))
* **workspaces:** shared workspaces with a per-seat Team plan on Stripe ([#170](https://github.com/kgoedecke/doop/issues/170)) ([f64c9ab](https://github.com/kgoedecke/doop/commit/f64c9ab869cdc5742a385fbe5fab43b4b59304c6))


### Bug Fixes

* **canvas:** clicking a second element in a frame moves the selection ([#171](https://github.com/kgoedecke/doop/issues/171)) ([bd23ae6](https://github.com/kgoedecke/doop/commit/bd23ae6818221a947245f6ef1bbbd304fc121c25))
* **canvas:** guard Layers drops against void targets and stale selectors ([#169](https://github.com/kgoedecke/doop/issues/169)) ([8cfcd1a](https://github.com/kgoedecke/doop/commit/8cfcd1a050b401b8a011735a0a336dade07a93ec))
* **layers:** delete key on a layer row no longer deletes the whole frame ([#179](https://github.com/kgoedecke/doop/issues/179)) ([377ae4c](https://github.com/kgoedecke/doop/commit/377ae4c003ba56cbf9dafe1c06266b6aee5e8ec6))
* **mcp:** bill agent comment replies to the connecting user, not the canvas owner ([5198236](https://github.com/kgoedecke/doop/commit/5198236d7ef2bd7e38068af1b4877f1d9ad66fee))
* **mcp:** protected-resource metadata names the /mcp endpoint so strict OAuth clients can connect ([#174](https://github.com/kgoedecke/doop/issues/174)) ([fcf2947](https://github.com/kgoedecke/doop/commit/fcf2947b9c8d292cde3fa44ccd027ea3e8049c28))
* **replay:** capture sandboxed frame content in PostHog ([#176](https://github.com/kgoedecke/doop/issues/176)) ([4a50323](https://github.com/kgoedecke/doop/commit/4a50323d15f2efd750479214ddbeead384ddab4a))
* **workspaces:** order billing events across subscriptions, durable revocations, owner-only moves in ([33aff5c](https://github.com/kgoedecke/doop/commit/33aff5c6c5c482095137f3e52e3d2b7cfdf70ee5))

## [0.4.0](https://github.com/kgoedecke/doop/compare/v0.3.0...v0.4.0) (2026-09-10)


### Features

* **auth:** sign in with Google, and enforce SIGNUP_EMAIL_DOMAINS on every sign-up path ([#159](https://github.com/kgoedecke/doop/issues/159)) ([1a78a84](https://github.com/kgoedecke/doop/commit/1a78a8411a6e257ba8a12c22a788c0eb875c540f))
* **auth:** sign in with Microsoft ([#160](https://github.com/kgoedecke/doop/issues/160)) ([b736528](https://github.com/kgoedecke/doop/commit/b736528e57ba5e43f7e081ed1aaf2e6a59fd6bd5))
* **backgrounds:** list_backgrounds — browse the library by eye instead of keyword search ([#154](https://github.com/kgoedecke/doop/issues/154)) ([941074f](https://github.com/kgoedecke/doop/commit/941074f0ef7f37a0bdd4d0da46ec68ad75fe442c))
* **canvas:** collapsible side rail replaces the top-bar Activity button ([#158](https://github.com/kgoedecke/doop/issues/158)) ([619734e](https://github.com/kgoedecke/doop/commit/619734eae2e356497d05f3fabd3d55936b5efb4d))
* **canvas:** element properties panel opens from a Layers row ([#161](https://github.com/kgoedecke/doop/issues/161)) ([80c63ad](https://github.com/kgoedecke/doop/commit/80c63ad95364afa21a046c9239d3b4a62244f85a))
* **canvas:** layers panel on the left, frame inspector moves right ([#157](https://github.com/kgoedecke/doop/issues/157)) ([86a2c9c](https://github.com/kgoedecke/doop/commit/86a2c9c85d4fe7e6b17f98d350501855f9af2936))
* **canvas:** present mode plays the selected frame full-screen ([#163](https://github.com/kgoedecke/doop/issues/163)) ([ccab4eb](https://github.com/kgoedecke/doop/commit/ccab4eb3323a1979b796a40c08eeb4d69e708b86))
* **canvas:** restyle the top bar after the Doop interface reference ([#156](https://github.com/kgoedecke/doop/issues/156)) ([2a45f34](https://github.com/kgoedecke/doop/commit/2a45f34484112ee275f2fb99bbff77f1ebf63073))
* **inspiration:** drop the recipe menu; the brief starts with a live search ([#134](https://github.com/kgoedecke/doop/issues/134)) ([c3aaa0c](https://github.com/kgoedecke/doop/commit/c3aaa0c61d2eda6f4ba3991539d2589abdf9b53a))
* **mcp:** search_backgrounds tool over a curated background library ([#152](https://github.com/kgoedecke/doop/issues/152)) ([1c4852f](https://github.com/kgoedecke/doop/commit/1c4852f3b74ddae90010b4c23e44a0b2d09be6a9))


### Bug Fixes

* **desktop:** cmd+w closes the active tab instead of the app, logout lands on /auth ([#155](https://github.com/kgoedecke/doop/issues/155)) ([eaeebd2](https://github.com/kgoedecke/doop/commit/eaeebd2414679ba61ff46cdc17080c53582d1b92))

## [0.3.0](https://github.com/kgoedecke/doop/compare/v0.2.0...v0.3.0) (2026-09-09)


### Features

* **agents:** demand real logos via search_logos instead of placeholders ([#149](https://github.com/kgoedecke/doop/issues/149)) ([1051c5e](https://github.com/kgoedecke/doop/commit/1051c5e3396d32ddf095bc9b3794d8195860f680))
* **canvas:** marquee selection, shift-click multi-select and space-to-pan ([#141](https://github.com/kgoedecke/doop/issues/141)) ([1b1a5f6](https://github.com/kgoedecke/doop/commit/1b1a5f65f5a153abfb8d03f2eb7aea3926fa33aa))
* **comments:** reply inside an element comment thread ([#140](https://github.com/kgoedecke/doop/issues/140)) ([cd7e6ee](https://github.com/kgoedecke/doop/commit/cd7e6eef3b3385f296d4ccbbee28988b8fe0cb6d))
* **community:** gallery of published designs to preview and copy ([#147](https://github.com/kgoedecke/doop/issues/147)) ([83a2773](https://github.com/kgoedecke/doop/commit/83a27733afb9c856922da1af8e6e75d0470bbba7))
* **desktop:** add Windows application support ([#112](https://github.com/kgoedecke/doop/issues/112)) ([2899cc3](https://github.com/kgoedecke/doop/commit/2899cc3c9d5fad5fee82529f78ae5a4f73a5eb61))
* **github:** queue repo imports as board cards instead of outline frames ([#138](https://github.com/kgoedecke/doop/issues/138)) ([e495537](https://github.com/kgoedecke/doop/commit/e495537d07fb516e1e8dbff34a4a80f017319789))
* **importer:** drop [@font-face](https://github.com/font-face) blocks the page never uses ([#126](https://github.com/kgoedecke/doop/issues/126)) ([9dc4230](https://github.com/kgoedecke/doop/commit/9dc4230439d5ed63d66be85082afa187ab6785f2))
* **importer:** prune CSS the captured page does not use ([#125](https://github.com/kgoedecke/doop/issues/125)) ([1f03123](https://github.com/kgoedecke/doop/commit/1f03123f179a75816131308e9ef33bed893769a7))
* **mcp:** add read-only access to canvas comments ([#117](https://github.com/kgoedecke/doop/issues/117)) ([bbb174e](https://github.com/kgoedecke/doop/commit/bbb174e24c06f1bf4d6ba4e5c384b452a5eb3204))
* **ui:** doop mark for agents and coloured crew badges on the board ([#144](https://github.com/kgoedecke/doop/issues/144)) ([1fd46f4](https://github.com/kgoedecke/doop/commit/1fd46f4d0325abd08aedee9e1ed6a6b1753aa75c))


### Bug Fixes

* **agent:** stream Anthropic turns so long recon runs are not refused ([#130](https://github.com/kgoedecke/doop/issues/130)) ([bd48e16](https://github.com/kgoedecke/doop/commit/bd48e163d950897845ebb2c3909b8e921e492a5f))
* **canvas:** copy, paste and duplicate the whole selection ([#146](https://github.com/kgoedecke/doop/issues/146)) ([238dd70](https://github.com/kgoedecke/doop/commit/238dd70dc34aadaf0fcad1ce0f6a4fed2f537b91))
* **canvas:** satisfy strict TypeScript and lint in the multi-frame clipboard port ([9061782](https://github.com/kgoedecke/doop/commit/9061782bdac5a78e73ce2aba84e561e9dfe227a1))
* **cards:** stop truncating a queued card's prompt at 200 chars ([#88](https://github.com/kgoedecke/doop/issues/88)) ([dbc9f31](https://github.com/kgoedecke/doop/commit/dbc9f3173d29625364e2779ad85ca8741e76db03))
* **community:** size modal preview tiles to the clipped thumbnail, not the frame ([#148](https://github.com/kgoedecke/doop/issues/148)) ([97ffab9](https://github.com/kgoedecke/doop/commit/97ffab9712f7023c741dbf298ea3318ce130b227))
* correct contrast on tag chip and rules new button ([#111](https://github.com/kgoedecke/doop/issues/111)) ([86a42f1](https://github.com/kgoedecke/doop/commit/86a42f1d20b18393306121c8b417f252cca69609))
* **dash:** point Help & docs at /docs instead of /blog ([#142](https://github.com/kgoedecke/doop/issues/142)) ([503ac68](https://github.com/kgoedecke/doop/commit/503ac68df68020d75b16b99f7bf30fd254ed521c))
* **dash:** point Help & docs at the hosted docs site ([396ccba](https://github.com/kgoedecke/doop/commit/396ccba5e01977da7a5ccf71a5304740f5df71bf))
* **frame:** confirm the code block copy ([#93](https://github.com/kgoedecke/doop/issues/93)) ([fc1f3fa](https://github.com/kgoedecke/doop/commit/fc1f3fa75a121b3eb4bc4c93e220982afdbfb512))
* **frame:** make the code view scrollable ([#94](https://github.com/kgoedecke/doop/issues/94)) ([dcacb21](https://github.com/kgoedecke/doop/commit/dcacb21c4c0c9b691a9013e21d34bb58485f21a0))
* **importer:** allow bigger stylesheets ([#114](https://github.com/kgoedecke/doop/issues/114)) ([009e7be](https://github.com/kgoedecke/doop/commit/009e7be81668f1ee4a1ff7dc3a0cd9a1618861a8))
* **importer:** keep [@font-face](https://github.com/font-face) blocks when the font shorthand uses var() ([#129](https://github.com/kgoedecke/doop/issues/129)) ([76e9343](https://github.com/kgoedecke/doop/commit/76e9343226210bf5f64ea5abb01329faee24bf8c))
* make extractHtml accept html without doctype and component fragments ([#119](https://github.com/kgoedecke/doop/issues/119)) ([22a8a8a](https://github.com/kgoedecke/doop/commit/22a8a8a42d8b6be1251adb4134164e89c44156e8))
* **stage:** pinch to zoom on touch screens ([#137](https://github.com/kgoedecke/doop/issues/137)) ([c91d60c](https://github.com/kgoedecke/doop/commit/c91d60cf0cc91c7fbef6c6e679293965c00343da))
* **ui:** default the codex mark to black instead of the presence colour ([cf030d9](https://github.com/kgoedecke/doop/commit/cf030d998dceb41156bf2559943e8feaf57c4bfa))

## [0.2.0](https://github.com/kgoedecke/doop/compare/v0.1.0...v0.2.0) (2026-09-03)


### Features

* add canvas actions and duplication ([#97](https://github.com/kgoedecke/doop/issues/97)) ([f671e76](https://github.com/kgoedecke/doop/commit/f671e76de462cbdf757c97d78e159af4842ad454))
* add Context.dev-backed website imports ([100e162](https://github.com/kgoedecke/doop/commit/100e162cacd9f007642677a023199a0f6091d092))
* add generic OIDC/SSO support ([#49](https://github.com/kgoedecke/doop/issues/49)) ([88b1fe3](https://github.com/kgoedecke/doop/commit/88b1fe34ac6f1011c1b9f52b8116c68d40c51219))
* **admin:** instance admin surface with read-only view-as ([10156ef](https://github.com/kgoedecke/doop/commit/10156efeb889f05527a9ff0062eaba959fe4c311))
* **admin:** restyle /admin to match home and settings ([dae3de5](https://github.com/kgoedecke/doop/commit/dae3de528dc1f124e6d29e1d0ee24bacec6950c8))
* **agent:** design-brief inspiration retrieval — style recipes + live refero search ([1c949b8](https://github.com/kgoedecke/doop/commit/1c949b8fa7ccf4004f0d3c5ccf4aacd40aa42271))
* **agent:** remove the free Doop Agent allowance ([e0f640d](https://github.com/kgoedecke/doop/commit/e0f640de37f7fc5446a4d4345c5bb7d5971833e2))
* **agent:** run the Doop Agent's server tier on Azure OpenAI ([e367ca5](https://github.com/kgoedecke/doop/commit/e367ca53eca5dfae8fed333425577460bfba7a53))
* **analytics:** capture custom agent connect and use in PostHog ([2e70352](https://github.com/kgoedecke/doop/commit/2e703529f9a8847ebbf75475d056ed19defacaa6))
* **analytics:** segment desktop-app sessions in PostHog ([#26](https://github.com/kgoedecke/doop/issues/26)) ([7d0a318](https://github.com/kgoedecke/doop/commit/7d0a318dde65a8876c7432a41c720a2189c9763b))
* **auth:** make email verification optional via REQUIRE_EMAIL_VERIFICATION ([7b82e57](https://github.com/kgoedecke/doop/commit/7b82e575a91b42ce72ca833774abf70545b934bf))
* **auth:** restrict signups by email domain ([#44](https://github.com/kgoedecke/doop/issues/44)) ([10dae3d](https://github.com/kgoedecke/doop/commit/10dae3d7e205bc39d42d22d5142f5c4cbbdbc61c))
* ban and unban accounts from the admin dashboard ([5de4803](https://github.com/kgoedecke/doop/commit/5de480352346027d545e148c97ca5a8828bf16ed))
* **canvas:** ⌥⇧-drag duplicates a frame; ⌘0/⌘+/⌘− zoom shortcuts ([97bf266](https://github.com/kgoedecke/doop/commit/97bf26613dae3abf351145ae1a7b1213efa779cd))
* **canvas:** render append_frame_html chunks instantly instead of pacing them ([dffc2d7](https://github.com/kgoedecke/doop/commit/dffc2d7e68a9918f9ca46ffc8069b6fb41140500))
* **canvas:** sync icon on frames pushed by the design-sync snippet ([7e5903d](https://github.com/kgoedecke/doop/commit/7e5903de4b036de5f3194448158dd123ee2d6e10))
* design-sync refinements — import-once, pristine first captures, agent flow context ([f98ce7a](https://github.com/kgoedecke/doop/commit/f98ce7a9563af49e06810f5d72a9b985e7942967))
* design-sync snippet — an app's live screens land on a canvas ([534934f](https://github.com/kgoedecke/doop/commit/534934fb2216e42c90de764ec0ed511bf03fbac4))
* **design:** move the app onto the Disc-D identity and editorial system ([df5a134](https://github.com/kgoedecke/doop/commit/df5a1346c68df7bef1e7c4953323356f00258c75))
* desktop shell (Tauri) with signed DMG releases ([#25](https://github.com/kgoedecke/doop/issues/25)) ([3f26286](https://github.com/kgoedecke/doop/commit/3f262866a90f8964cd63cf461372bcf35c9f26af))
* **desktop:** figma-style canvas tabs, overlay title bar, external links open in the browser ([#93](https://github.com/kgoedecke/doop/issues/93)) ([3dcc1a5](https://github.com/kgoedecke/doop/commit/3dcc1a5098b43413c9ba2412a19c197d7862e097))
* flow map — connectors show which button leads to which screen ([e1a4453](https://github.com/kgoedecke/doop/commit/e1a445337f1de54e12f518eeddfa1ce09a815261))
* **github-import:** agent reconstruction of code-only screens ([0981875](https://github.com/kgoedecke/doop/commit/0981875521ed904dccef3e32ed9407254a2c90a2))
* **github-import:** components and design system become the headline ([6127e04](https://github.com/kgoedecke/doop/commit/6127e0405afb3549e1795f5057b79cb82d7d8fe8))
* **github-import:** one-click GitHub App install flow ([331cd88](https://github.com/kgoedecke/doop/commit/331cd887e89c1f21631a01e2f27437d59f76e19c))
* **github-import:** review flow leads with the design system ([09301ee](https://github.com/kgoedecke/doop/commit/09301ee36b6593e2d635f3a53c14f7fb3a85f1d1))
* **github-recon:** render-critique round — the sketch reviews itself ([b0ade2e](https://github.com/kgoedecke/doop/commit/b0ade2e346e098a314da8c1988d1de381a54c512))
* **github-recon:** the model investigates the repo before designing ([3bce7c1](https://github.com/kgoedecke/doop/commit/3bce7c1026d18d79e7baa8c6afe0207306796e69))
* **github-recon:** the sketch pass shows up as Doop working ([ff59d6d](https://github.com/kgoedecke/doop/commit/ff59d6d8a7454b9186c49daad29f5e974027c036))
* **github-recon:** transplant real repo assets, full-page output ([77483e9](https://github.com/kgoedecke/doop/commit/77483e9153d21e83c6986324279c474412df3890))
* **guide:** taste curriculum — mood method, brief ritual, anchor and hero-review rules ([87f9246](https://github.com/kgoedecke/doop/commit/87f9246acd76ff58240b9629d34831a37469accf))
* import complete websites with page review ([5567f17](https://github.com/kgoedecke/doop/commit/5567f170c24196ef512e08c998b867fab4709eee))
* **import:** connect a GitHub repo as an import source ([7392e11](https://github.com/kgoedecke/doop/commit/7392e11556bce2d9aad6ccf9a1abbe877b661cf0))
* **inspo:** refero.design style extractor (inspiration pipeline v0) ([9634d6f](https://github.com/kgoedecke/doop/commit/9634d6f6437316f9491ee2242b8ce0c79efb95b6))
* meter feedback and retries — every resident trigger spends a free task ([4949a5f](https://github.com/kgoedecke/doop/commit/4949a5faa7f810902dc15fb0c6fe8d82a667ae3d))
* right-click menu on desktop canvas tabs; signed-out visitors always see sign-in ([#104](https://github.com/kgoedecke/doop/issues/104)) ([d79a0c6](https://github.com/kgoedecke/doop/commit/d79a0c6f7e70a055cf3436d20598580990b7ca58))
* run the Doop Agent on your own ChatGPT subscription ([c99ed93](https://github.com/kgoedecke/doop/commit/c99ed93c0616bbc11d07401f26b9258d4effc77f))
* **server:** surface Doop Agent state at boot ([1edec74](https://github.com/kgoedecke/doop/commit/1edec748b35419a9816e5967914468ed672ea77d))
* **ui:** a component system for Doop, and the end of plain CSS ([26891dc](https://github.com/kgoedecke/doop/commit/26891dcb4b348146176de890cba4fd6b38a51b81))
* workspace-rail dashboard for home and settings ([73f31e0](https://github.com/kgoedecke/doop/commit/73f31e0f22b063eba1675d29f102f1ff79d8794b))


### Bug Fixes

* a stalled agent queue no longer hides another agent's runnable work ([66e72af](https://github.com/kgoedecke/doop/commit/66e72af501e669fa0605525712840655748ebd29))
* **admin:** back button during "view as" returns to admin instead of 404 ([43ceb95](https://github.com/kgoedecke/doop/commit/43ceb951939202a640a5522177821b4810def580))
* **agent:** only a connected model account lifts the resident meter ([2701602](https://github.com/kgoedecke/doop/commit/2701602305f7c9b94fed030b3b7e696753419daa))
* **agent:** read Codex-backend output from streamed items, not the completed event ([258ee8f](https://github.com/kgoedecke/doop/commit/258ee8fb2da719842e449ba0ea507cdf37d98e99))
* bill one requester per agent run, and stop two account races ([7556094](https://github.com/kgoedecke/doop/commit/7556094c961ded6d4cc247ad05f37f73fc5a5e26))
* **canvas:** move live-app sync keys from the share dialog to Import ([b16ba55](https://github.com/kgoedecke/doop/commit/b16ba551f721356306e153a4a5b5e6bd4a74b33d))
* **canvas:** open the frame details panel only from a frame-name click ([b844709](https://github.com/kgoedecke/doop/commit/b844709dc7e7d38c4cbbbd39f1125170eba1fa99))
* **canvas:** raise the element toolbar above the pin-to-memory brain button ([8266df5](https://github.com/kgoedecke/doop/commit/8266df51d85ce1eba0cc223ec621acd65a01ade9))
* **canvas:** show the duplicate cursor while ⌥⇧ is held, not at drag-start ([94ca0fc](https://github.com/kgoedecke/doop/commit/94ca0fc4f73d2066255b65199fab0d2790b3d61d))
* **ci:** give doc-lint node globals and repo formatting ([2b73aef](https://github.com/kgoedecke/doop/commit/2b73aef956d9af6b5a22854e41e45ebbaabed58b))
* compile the PostHog support widget into the no-external bundle ([62e3992](https://github.com/kgoedecke/doop/commit/62e3992a3fc429a0b9b79031ccf1108ea8f7d9ef))
* **dashboard:** reliable canvas previews — persisted thumbnails, stale-while-revalidate ([3aaad88](https://github.com/kgoedecke/doop/commit/3aaad88936af4a9eab96afdf1d11bafb66869314))
* **dashboard:** rounded corners on active view-mode segment ([30e1907](https://github.com/kgoedecke/doop/commit/30e190759a1b7ad3daa2f05ad2b3394fbc9b215a))
* disable vertical tab bar scrolling ([#85](https://github.com/kgoedecke/doop/issues/85)) ([45250cc](https://github.com/kgoedecke/doop/commit/45250cc7dbf94250b4ed95129a0ebb951af5a384))
* **github-app:** handle already-installed accounts; surface install failures on the canvas ([ae1e155](https://github.com/kgoedecke/doop/commit/ae1e1553f82ca2090e7524c30a67cfdab8c1fb46))
* **github-import:** actionable failed-sketch card; fail fast on dead model accounts ([6b572b4](https://github.com/kgoedecke/doop/commit/6b572b4f55c09d978cd9b8618b65e0543d101841))
* **github-import:** default to design-system-only; name the CTA honestly ([8d0aa10](https://github.com/kgoedecke/doop/commit/8d0aa106f9c150ac762442434e5887536e9ff25a))
* **github-import:** deploy URL editable after connect; resync upgrades placeholders ([ce4a262](https://github.com/kgoedecke/doop/commit/ce4a26277e97aba43f4e6fc49dff5ae7f52155f5))
* **github-import:** outline prompts deep-link to their exact frame ([e9e26d3](https://github.com/kgoedecke/doop/commit/e9e26d327251c773b43511769616f160210c4c78))
* hide demo frames from agents so they don't steer new designs ([de5e3a5](https://github.com/kgoedecke/doop/commit/de5e3a5689114f340217151ccc1b5b844ce50906))
* **importer:** skip the scroll walk for Context.dev captures so imports stop hanging ([63b46ec](https://github.com/kgoedecke/doop/commit/63b46eca9081e51289aca87cc8503f89a14f57f2))
* **mcp:** state one-query-per-call in search_icons and search_logos descriptions ([a7a014f](https://github.com/kgoedecke/doop/commit/a7a014f4be4ca7ee1ed64023a343ae76aa503d40))
* preserve X-Forwarded-For chain in PostHog relay so recordings geolocate the real client ([7d0fab4](https://github.com/kgoedecke/doop/commit/7d0fab4513e885bbacebc6ed488f1f6e55ec9873))
* **server:** decode HTML-escaped frame writes ([3c64285](https://github.com/kgoedecke/doop/commit/3c6428553847eb3fee398d3f0f6cc64547976a6a))
* snippet finds its config when injected by a tag manager ([b5d892c](https://github.com/kgoedecke/doop/commit/b5d892ca0859e364db0f1343fade0ed2f0445570))
* sync key rides in the snippet URL — the form tag managers can't strip ([6739094](https://github.com/kgoedecke/doop/commit/6739094e42dfaf81f4a640504c7ad9f9dec1dc4e))
* **tests:** move admin suite to ports 4985-4988, clear of parallel test files ([13f00ea](https://github.com/kgoedecke/doop/commit/13f00ea9d2ecca24ebf353b1861d43031524ade3))
* **ui:** hand the limit wall's MCP path off to the connect modal ([baadd86](https://github.com/kgoedecke/doop/commit/baadd86c08a1dedb5e8194e418c272d8b80ecec3))


### Documentation

* add discord badge to readme ([d76cf05](https://github.com/kgoedecke/doop/commit/d76cf0539830e97c7722b39874e8c8b2941e4d6b))
* add link to doop website in readme ([#96](https://github.com/kgoedecke/doop/issues/96)) ([f51ba0c](https://github.com/kgoedecke/doop/commit/f51ba0c7bc42ea4f4bbf31b7a9cb07a36fcb64c6))
* document Doop Agent setup and standardise its name ([b92b65b](https://github.com/kgoedecke/doop/commit/b92b65bbae2646aaee33384c93ac8aa2edb06e77))
* rebuild the README graphics on the Disc-D identity ([#87](https://github.com/kgoedecke/doop/issues/87)) ([5d5a732](https://github.com/kgoedecke/doop/commit/5d5a73223453fb5998512ed9cb1a62cc2436e081))
