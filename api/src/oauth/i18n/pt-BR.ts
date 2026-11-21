import type { Translation } from '@shared/i18n';

import type en from './en';

const m: Translation<typeof en> = {
  'consent.title': 'Autorizar acesso - Budget',
  'consent.heading': 'Autorizar <strong>{client}</strong>?',
  'consent.signedIn': 'Você entrou como <strong>{email}</strong>.',
  'consent.sentBack': 'Este aplicativo será redirecionado para <code>{host}</code> e poderá:',
  'consent.invalidHost': '(inválido)',
  'consent.scopeRead': 'Ver os dados do seu orçamento',
  'consent.scopeWrite': 'Fazer alterações nos dados do seu orçamento',
  'consent.approve': 'Aprovar',
  'consent.deny': 'Negar',
  'error.title': 'Erro de autorização',
  'error.heading': 'Não é possível autorizar',
  'error.unknownClient': 'Cliente desconhecido.',
  'error.redirectNotRegistered': 'O redirect_uri não está registrado para este cliente.',
  'error.tooLargeToResume': 'A solicitação é grande demais para retomar após a entrada.',
  'error.crossOrigin': 'Solicitação de outra origem recusada.',
  'error.sessionExpired': 'Sua sessão expirou. Comece de novo.',
  'error.invalidForm': 'Formulário inválido ou expirado. Comece de novo.',
  'error.notAuthorized': 'Não autorizado.',
  'error.accountDisabled': 'Conta desativada.',
  'error.badRequest': 'Solicitação inválida.',
  'error.bodyTooLarge': 'A solicitação é grande demais.',
  'error.invalidJson': 'A solicitação não é um JSON válido.',
};

export default m;
