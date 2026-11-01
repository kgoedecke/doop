import type { Catalog } from '..'

export const webhooks: Catalog['webhooks'] = {
  healthOff: 'desativado, então nada é enviado',
  healthNoDeliveries: 'nenhuma entrega ainda',
  healthFailing: {
    one: '{count} falha seguida · última {when}: {error}',
    other: '{count} falhas seguidas · última {when}: {error}',
  },
  healthFailed: 'falhou',
  healthDelivered: 'entregue {when} (HTTP {status})',

  eventCommentCreated: 'Um comentário é deixado em um elemento',
  eventCommentReplied: 'Uma resposta chega em uma conversa de comentários',
  eventCommentResolved: 'Uma conversa de comentários é resolvida',
  eventFrameCreated: 'Um frame é criado',
  eventTaskCompleted: 'Um agente conclui um card do quadro',
  eventTaskFailed: 'Um agente falha em um card do quadro',

  loadFailed: 'Não foi possível carregar seus webhooks',
  createFailed: 'Não foi possível criar esse webhook',
  pingAnswered: 'ping respondido com HTTP {status}',
  pingFailed: 'ping falhou: {error}',
  pingNoResponse: 'sem resposta',
  testFailed: 'Não foi possível enviar o teste',
  toggleFailed: 'Não foi possível salvar',
  rotateFailed: 'Não foi possível trocar o segredo',
  removeFailed: 'Não foi possível remover esse webhook',

  title: 'Webhooks',
  descriptionBefore:
    'O doop envia um POST com um evento JSON assinado para cada URL abaixo quando algo acontece em um canvas que é seu, para o qual você foi convidado ou que está em um dos seus workspaces. Encaminhe para o Slack, n8n, um rastreador de issues, qualquer coisa com um endpoint HTTP. Cada entrega leva um cabeçalho ',
  descriptionAfter:
    ' (HMAC-SHA256 com o segredo do webhook) para que o destinatário possa confiar nela. Entregas que falham são tentadas de novo três vezes; um webhook que continua falhando se pausa sozinho.',
  newWebhookRow: 'Novo webhook',
  adding: 'Adicionando…',
  addWebhook: 'Adicionar webhook',
  urlAria: 'URL do webhook',

  signingSecretRow: 'Segredo de assinatura',
  copyNow: 'Copie agora: ele é mostrado uma única vez. Use-o para verificar as entregas do seu lado.',
  signatureFormula:
    'signature = “sha256=” + HMAC-SHA256(secret, X-Doop-Timestamp + “.” + raw body). A documentação tem uma verificação pronta.',

  sendTest: 'Enviar teste',
  rotateSecret: 'Trocar segredo',
  turnOff: 'Desativar',
  turnOn: 'Ativar',
  removeAria: 'Remover webhook de {host}',
  remove: 'Remover',
  noWebhooksRow: 'Nenhum webhook ainda',
  noWebhooksNote: 'Adicione um acima. Um jeito rápido de testar é um nó Webhook do n8n ou um request bin.',

  rotateConfirmTitle: 'Trocar o segredo de {host}?',
  removeConfirmTitle: 'Remover o webhook de {host}?',
  rotateConfirmDescription: 'Entregas assinadas com o segredo antigo deixam de ser verificadas.',
  removeWebhook: 'Remover webhook',
}
