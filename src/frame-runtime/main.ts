import { installBleed } from './bleed'
import { installCommands, installFrameUpdates } from './commands'
import { installEdit } from './edit'
import { installKeyRelay } from './keyRelay'
import { installWheelRelay } from './wheelRelay'
import { installProto } from './proto'
import { installReplay } from './replay'
import { installSheets } from './sheets'
import { installText } from './text'

/* The frame runtime: the script FRAME_BOOTSTRAP runs in every frame iframe,
   built into one IIFE by vitePlugin.ts. Every module only declares; what
   the runtime sets up in the document happens here, in this order, because
   listeners on one target run in the order they were added: the prototype's
   capturing click runs before the text editor's, the list shortcut's input
   listener stops the typing save's, the prototype's keys go before the
   Escape relay, and the editor's commands are taken (capturing, last) before
   any listener a design adds. The channel to the editor (channel.ts) pins
   what it relies on when its module is evaluated, ahead of all of this and
   of any design script. */

installReplay()
installProto()
installSheets()
installBleed()
installText()
installEdit()
installKeyRelay()
installWheelRelay()
installFrameUpdates()
installCommands()
parent.postMessage({ type: 'doop:frame-ready' }, '*')
