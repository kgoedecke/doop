import { splitCssList } from '../../lib/designProperties'
import { Button } from '../ui/button'
import { DesignInput, PropertyField, selectClass } from './Controls'
import { readGradient, readShadow, writeGradient, writeShadow } from '../../lib/designPaints'

/** CSS paint stacks are kept lossless, including unfamiliar gradients/URLs.
 * Presets are starting values; each entry remains directly editable. */
export function PaintStack({
  kind,
  value,
  onCommit,
}: {
  kind: 'fill' | 'shadow'
  value: string
  onCommit(value: string): void
}) {
  const layers = splitCssList(value)
  const label = kind === 'fill' ? 'Fill' : 'Shadow'
  function update(index: number, next: string) {
    const values = layers.map((item, i) => (i === index ? next : item)).filter((item) => item.trim())
    onCommit(values.join(', ') || 'none')
  }
  return (
    <div className="col-span-2 space-y-2">
      {layers.map((layer, index) => (
        <div key={`${index}:${layer}`} className="rounded-lg border border-line-soft bg-paper/40 p-2">
          <div className="mb-1.5 flex items-center gap-1">
            <span className="mr-auto text-[10px] font-medium text-ink-soft">
              {label} {index + 1}
            </span>
            <button
              type="button"
              aria-label={`Move ${label.toLowerCase()} ${index + 1} up`}
              disabled={index === 0}
              className="px-1 text-xs disabled:opacity-25"
              onClick={() => {
                const next = [...layers]
                ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                onCommit(next.join(', '))
              }}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
              className="px-1 text-xs text-ink-faint hover:text-accent-ink"
              onClick={() => update(index, '')}
            >
              ×
            </button>
          </div>
          <PaintFields
            kind={kind}
            label={`${label} ${index + 1}`}
            value={layer}
            onCommit={(next) => update(index, next)}
          />
        </div>
      ))}
      <select
        className={selectClass}
        aria-label={`Add ${kind}`}
        value=""
        onChange={(e) => {
          const presets: Record<string, string> = {
            linear: 'linear-gradient(135deg, #2743ee 0%, #a5b4fc 100%)',
            radial: 'radial-gradient(circle at center, #a5b4fc 0%, #2743ee 100%)',
            conic: 'conic-gradient(from 0deg, #2743ee, #a5b4fc, #2743ee)',
            image: 'url("")',
            drop: '0px 4px 16px 0px rgba(0, 0, 0, 0.16)',
            inner: 'inset 0px 2px 8px 0px rgba(0, 0, 0, 0.18)',
          }
          if (presets[e.target.value]) onCommit([...layers, presets[e.target.value]].join(', '))
        }}
      >
        <option value="">+ Add {kind === 'fill' ? 'fill layer' : 'shadow'}</option>
        {kind === 'fill' ? (
          <>
            <option value="linear">Linear gradient</option>
            <option value="radial">Radial gradient</option>
            <option value="conic">Angular gradient</option>
            <option value="image">Image URL</option>
          </>
        ) : (
          <>
            <option value="drop">Drop shadow</option>
            <option value="inner">Inner shadow</option>
          </>
        )}
      </select>
      {layers.length > 0 && (
        <Button variant="bare" size="sm" className="text-[10px] text-ink-faint" onClick={() => onCommit('')}>
          Reset {kind === 'fill' ? 'fill layers' : 'shadows'}
        </Button>
      )}
    </div>
  )
}

function PaintFields({
  kind,
  label,
  value,
  onCommit,
}: {
  kind: 'fill' | 'shadow'
  label: string
  value: string
  onCommit(value: string): void
}) {
  const shadow = kind === 'shadow' ? readShadow(value) : null
  const gradient = kind === 'fill' ? readGradient(value) : null
  const url = kind === 'fill' ? value.match(/^url\(["']?(.*?)["']?\)$/s) : null
  let fields: React.ReactNode = null
  if (shadow)
    fields = (
      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label={`${label} type`}
          className={`${selectClass} col-span-2`}
          value={shadow.inset ? 'inner' : 'drop'}
          onChange={(e) => onCommit(writeShadow({ ...shadow, inset: e.target.value === 'inner' }))}
        >
          <option value="drop">Drop shadow</option>
          <option value="inner">Inner shadow</option>
        </select>
        {(['x', 'y', 'blur', 'spread'] as const).map((key) => (
          <div key={key}>
            <span className="mb-1 block text-[10px] capitalize text-ink-soft">{key}</span>
            <DesignInput
              label={`${label} ${key}`}
              value={shadow[key]}
              onCommit={(next) => onCommit(writeShadow({ ...shadow, [key]: next }))}
            />
          </div>
        ))}
        <PropertyField
          field={{ key: 'color', label: `${label} color`, color: true, wide: true }}
          authored=""
          computed={shadow.color}
          onCommit={(_, color) => onCommit(writeShadow({ ...shadow, color }))}
        />
      </div>
    )
  if (gradient)
    fields = (
      <div className="space-y-2">
        <div aria-hidden className="h-12 rounded-md border border-line-soft" style={{ backgroundImage: value }} />
        <select
          aria-label={`${label} type`}
          className={selectClass}
          value={gradient.type}
          onChange={(e) => {
            const type = e.target.value as typeof gradient.type
            onCommit(
              writeGradient({
                ...gradient,
                type,
                direction: type === 'linear' ? '135deg' : type === 'radial' ? 'circle at center' : 'from 0deg',
              }),
            )
          }}
        >
          <option value="linear">Linear gradient</option>
          <option value="radial">Radial gradient</option>
          <option value="conic">Angular gradient</option>
        </select>
        <div>
          <span className="mb-1 block text-[10px] text-ink-soft">
            {gradient.type === 'linear' ? 'Angle' : 'Origin'}
          </span>
          <DesignInput
            label={`${label} direction`}
            value={gradient.direction}
            onCommit={(direction) =>
              onCommit(
                writeGradient({ ...gradient, direction: /^-?[\d.]+$/.test(direction) ? `${direction}deg` : direction }),
              )
            }
          />
        </div>
        {gradient.stops.map((stop, index) => (
          <div key={index} className="grid grid-cols-[1fr_60px_20px] items-end gap-1.5">
            <div>
              <span className="mb-1 block text-[10px] text-ink-soft">Stop {index + 1}</span>
              <DesignInput
                label={`${label} stop ${index + 1} color`}
                value={stop.color}
                onCommit={(color) =>
                  onCommit(
                    writeGradient({
                      ...gradient,
                      stops: gradient.stops.map((item, i) => (i === index ? { ...item, color } : item)),
                    }),
                  )
                }
              />
            </div>
            <DesignInput
              label={`${label} stop ${index + 1} position`}
              value={stop.position}
              onCommit={(position) =>
                onCommit(
                  writeGradient({
                    ...gradient,
                    stops: gradient.stops.map((item, i) =>
                      i === index
                        ? { ...item, position: /^-?[\d.]+$/.test(position) ? `${position}%` : position }
                        : item,
                    ),
                  }),
                )
              }
            />
            <button
              type="button"
              className="h-8 text-ink-faint disabled:opacity-20"
              aria-label={`Remove ${label.toLowerCase()} stop ${index + 1}`}
              disabled={gradient.stops.length <= 2}
              onClick={() =>
                onCommit(writeGradient({ ...gradient, stops: gradient.stops.filter((_, i) => i !== index) }))
              }
            >
              ×
            </button>
          </div>
        ))}
        <Button
          size="sm"
          variant="bare"
          onClick={() =>
            onCommit(
              writeGradient({
                ...gradient,
                stops: [
                  ...gradient.stops.slice(0, -1),
                  { color: '#ffffff', position: '50%' },
                  gradient.stops[gradient.stops.length - 1],
                ],
              }),
            )
          }
        >
          + Color stop
        </Button>
      </div>
    )
  if (url)
    fields = (
      <div>
        <span className="mb-1 block text-[10px] text-ink-soft">Image URL</span>
        <DesignInput
          label={`${label} image URL`}
          value={url[1]}
          onCommit={(next) => onCommit(`url(${JSON.stringify(next)})`)}
        />
      </div>
    )
  return (
    <>
      {fields}
      {fields ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] text-ink-faint">CSS value</summary>
          <DesignInput label={`${label} CSS`} value={value} multiline onCommit={onCommit} className="mt-2" />
        </details>
      ) : (
        <DesignInput label={`${label} CSS`} value={value} multiline onCommit={onCommit} />
      )}
    </>
  )
}
