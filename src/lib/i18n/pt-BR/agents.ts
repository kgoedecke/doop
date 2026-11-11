import type { Catalog } from '..'

export const agents: Catalog['agents'] = {
  title: 'Equipe de agentes',
  descriptionWorkspace: 'A equipe do Doop Agent em todos os canvases deste workspace.',
  descriptionPersonal: 'A equipe do Doop Agent nos canvases do seu espaço pessoal.',
  descriptionRest:
    'Desligue os agentes padrão de que você não precisa, mude como eles trabalham ou adicione os seus. As pessoas chamam um agente com @menção em um comentário ou na caixa de prompt, e automações podem entregar uma etapa a ele.',
  builtIn: 'Padrão',
  builtInNote:
    'Um agente desligado sai da lista de menções e das etapas de automação; o trabalho que esperava por ele vai para o Doop.',
  off: 'Desligado',
  edited: 'Editado',
  toggle: 'Usar {name}',
  defaultStaysOn: 'O Doop fica ligado: o trabalho sem destinatário vai para ele.',
  builtInLede:
    'Mude como este agente padrão trabalha para esta equipe. Suas instruções substituem as originais; Restaurar as traz de volta.',
  reset: 'Restaurar padrão',
  yours: 'Personalizados',
  loading: 'Carregando…',
  count: { one: '{count} agente personalizado', other: '{count} agentes personalizados' },
  full: 'A equipe está completa com {count} agentes personalizados. Remova um para adicionar outro.',
  add: 'Adicionar agente',
  edit: 'Editar',
  remove: 'Remover',
  emptyTitle: 'Nenhum agente personalizado ainda',
  emptyPersonal:
    'Adicione um especialista que a equipe padrão não tem, como um revisor de SEO ou a voz da sua marca, e mencione-o com @ nos seus canvases pessoais.',
  emptyWorkspace:
    'Adicione um especialista que a equipe padrão não tem, como um revisor de SEO ou a voz da sua marca, e todos no workspace podem mencioná-lo com @.',
  reviewerBadge: 'Revisão: pode terminar sem mudar nada',
  loadFailed: 'Não foi possível carregar os agentes personalizados.',
  removeFailed: 'Não foi possível remover o agente. Tente de novo.',
  saveFailed: 'Não foi possível salvar o agente. Tente de novo.',
  removeTitle: 'Remover {name}?',
  removeDescription:
    'Ele deixa de responder a @menções e sai da lista de etapas das automações. O trabalho que ainda esperava por ele vai para o Doop, e o que ele já fez continua.',
  addTitle: 'Adicionar um agente personalizado',
  editTitle: 'Editar {name}',
  formLede:
    'Um especialista na equipe do Doop Agent. As instruções dele entram no prompt do agente sempre que ele roda.',
  name: 'Nome',
  namePlaceholder: 'Revisor de SEO',
  fixedHint: 'O nome e o identificador não mudam: comentários e cards abertos apontam para eles.',
  handle: 'Identificador',
  blurb: 'Descrição em uma linha',
  blurbPlaceholder: 'Títulos, cabeçalhos e textos meta para busca',
  brief: 'Instruções',
  briefPlaceholder:
    'Você é o revisor de SEO. Confira se cada página tem um h1 claro, cabeçalhos descritivos em ordem e um texto que diz do que a página trata…',
  briefHint: '{used} / {max} caracteres. Diga o que ele cuida, o que verifica e o que deve deixar como está.',
  color: 'Cor',
  reviewer: 'Revisão',
  reviewerHint:
    'Ele avalia o trabalho existente e pode terminar sem editar quando o frame já atende ao padrão. Deixe desligado para um agente que cria coisas.',
  save: 'Salvar',
  create: 'Adicionar agente',
  saving: 'Salvando…',
}
