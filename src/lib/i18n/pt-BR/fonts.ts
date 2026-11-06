import type { Catalog } from '..'

export const fonts: Catalog['fonts'] = {
  title: 'Fontes',
  descriptionWorkspace: 'Fontes da marca para todos os canvases deste workspace.',
  descriptionPersonal: 'Suas próprias fontes, para os canvases do seu espaço pessoal.',
  descriptionRest:
    'Elas aparecem no menu de fontes do painel Design, e os agentes que criam nesses canvases são orientados a usá-las. Um frame que usa uma delas leva a fonte junto, então capturas de tela e exportações também a mostram.',
  upload: 'Enviar',
  uploadButton: 'Enviar fontes',
  uploading: 'Enviando…',
  chooseFiles: 'Escolher arquivos de fonte',
  loading: 'Carregando…',
  emptyTitle: 'Nenhuma fonte ainda',
  emptyPersonal:
    'Envie seus arquivos de fonte ou solte-os neste cartão, e eles aparecem no menu de fontes do painel Design nos seus canvases pessoais. Arquivos TTF, OTF, WOFF e WOFF2 de até 10 MB cada, um estilo por arquivo.',
  emptyWorkspace:
    'Envie os arquivos de fonte da sua marca ou solte-os neste cartão, e todos no workspace passam a vê-los no menu de fontes do painel Design. Arquivos TTF, OTF, WOFF e WOFF2 de até 10 MB cada, um estilo por arquivo.',
  fileRules: 'TTF, OTF, WOFF ou WOFF2, até 10 MB cada',
  dropNotFonts: 'Só arquivos TTF, OTF, WOFF e WOFF2 podem ser adicionados aqui.',
  families: { one: '{count} família', other: '{count} famílias' },
  files: { one: '{count} arquivo', other: '{count} arquivos' },
  summary: '{families}, {files}',
  preview: 'Um pequeno jabuti xereta viu dez cegonhas felizes',
  removeFace: 'Remover {family} {face}',
  removeTitle: 'Remover {family} {face}?',
  removeDescription:
    'Ela sai do menu de fontes e deixa de ser oferecida aos agentes. Frames que já a usam continuam a mostrá-la.',
  removeFamily: 'Remover família',
  removeFamilyTitle: { one: 'Remover {family}?', other: 'Remover {family} e seus {count} estilos?' },
  removeFamilyDescription:
    'Todos os estilos saem do menu de fontes e deixam de ser oferecidos aos agentes. Frames que já a usam continuam a mostrá-la.',
  remove: 'Remover',
  loadFailed: 'Não foi possível carregar a biblioteca de fontes',
  uploadFailed: 'falha no envio',
  tooLarge: '{name} passa do limite de 10 MB',
  removeFailed: 'Não foi possível remover essa fonte',
  addLocal: 'Adicionar deste computador',
  addLocalTitle: { one: 'Adicionar {name} a esta biblioteca?', other: 'Adicionar {count} fontes deste computador?' },
  addLocalDescription:
    'Todos que usam esta biblioteca recebem a fonte, e os frames que a usam a levam para capturas de tela e exportações. Fontes instaladas com o sistema operacional ou compradas para uma máquina costumam ser licenciadas só para o seu uso; verifique a licença da fonte antes de compartilhá-la aqui. O Doop não verifica licenças por você.',
  addLocalConfirm: 'Adicionar fontes',
  localSkipped: {
    one: '{names} não é um arquivo de fonte único (TTF, OTF, WOFF ou WOFF2) e ficou de fora.',
    other: '{names} não são arquivos de fonte únicos (TTF, OTF, WOFF ou WOFF2) e ficaram de fora.',
  },
  localTooLarge: {
    one: '{names} passa do limite de 10 MB e ficou de fora.',
    other: '{names} passam do limite de 10 MB e ficaram de fora.',
  },
  localReadFailed: 'Não foi possível ler {name} deste computador',
}
