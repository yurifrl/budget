import type { Translation } from '../types';
import type en from './en';

const m: Translation<typeof en> = {
  // Per-status defaults.
  bad_request: 'Não foi possível entender a solicitação.',
  unauthorized: 'Você precisa entrar.',
  forbidden: 'Você não tem acesso a isto.',
  not_found: 'Não encontrado.',
  conflict: 'Isto conflita com o estado atual. Recarregue e tente novamente.',
  too_large: 'A solicitação é grande demais.',
  unprocessable: 'Não foi possível processar a solicitação.',
  rate_limited: 'Muitas solicitações. Tente novamente em instantes.',
  internal: 'Algo deu errado do nosso lado. Tente novamente.',
  upstream_error: 'Um serviço conectado falhou. Tente novamente.',
  unavailable: 'O serviço está indisponível. Tente novamente mais tarde.',
  upstream_timeout: 'Um serviço conectado demorou demais. Tente novamente.',
  error: 'Algo deu errado.',
  // Specific codes.
  invalid_input: 'Algumas das informações digitadas não são válidas.',
  account_disabled: 'Esta conta está desativada.',
  insufficient_scope: 'Este acesso não permite essa ação.',
  already_archived: 'Isto já está arquivado.',
  invalid_credentials: 'E-mail ou senha inválidos.',
  temp_password_expired: 'A senha temporária expirou. Peça uma nova a um administrador.',
  invalid_change_token: 'Sua sessão de entrada expirou. Comece de novo.',
  too_many_attempts: 'Muitas tentativas. Tente novamente mais tarde.',
  origin_not_allowed: 'Esta origem não é permitida.',
  unsupported_media_type: 'O corpo da solicitação deve ser JSON.',
  no_password: 'Esta conta não tem senha.',
  password_too_short: 'A senha deve ter pelo menos 12 caracteres.',
  password_too_long: 'A senha deve ter no máximo 128 caracteres.',
  password_is_email: 'A senha não pode ser o seu e-mail.',
  password_too_common: 'Esta senha é comum demais. Escolha outra.',
  password_unchanged: 'A nova senha deve ser diferente da atual.',
  password_login_disabled: 'A entrada com senha está desativada.',
  user_exists: 'Já existe um usuário com este e-mail.',
  cannot_modify_self: 'Você não pode desativar, rebaixar ou excluir a si mesmo.',
  last_admin: 'O último administrador ativo não pode ser desativado, rebaixado ou excluído.',
  user_has_data: 'Este usuário tem dados. Desative-o em vez de excluir.',
};

export default m;
