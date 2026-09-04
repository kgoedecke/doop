/* Cross-component gesture state that never renders. A two-finger pinch on
   the stage has to silence whatever single-pointer drag the first finger
   started (a canvas pan, a frame move), and those drags live in other
   components — so the flag is a plain module value they can read on every
   pointermove without subscribing to anything. */
export const gesture = { pinching: false }
