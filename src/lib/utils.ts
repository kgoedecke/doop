import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/* The merger must know the design system's own `text-*` sizes and `rounded-*`
   shapes (src/styles.css @theme), or it files `text-body` under colours and
   drops the real colour class that sits beside it. */
const TEXT_SCALE = ['micro', 'caption', 'label', 'body', 'copy', 'lead', 'heading', 'title', 'display']
const RADIUS_SHAPES = ['tag', 'row', 'control', 'pill', 'card', 'panel']

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: TEXT_SCALE }],
      rounded: [{ rounded: RADIUS_SHAPES }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
