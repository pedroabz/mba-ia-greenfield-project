Frontend do **StreamTube** — Next.js 16 (App Router, React Server Components) + TypeScript strict, Tailwind CSS v4 e shadcn/ui.

Este subprojeto roda **dentro do Docker**. Todo comando `npm`/`npx` deve ser executado no container — rodar no host usa outra versão do Node e deixa artefatos com o usuário errado no bind mount.

## 🚀 Como rodar

```bash
cd next-frontend

# Cria o .env.local (obrigatório — lib/env.ts valida as vars no boot)
cp .env.example .env.local

# Gere um SESSION_PASSWORD próprio (mínimo 32 caracteres)
openssl rand -base64 32

# Sobe o container (o comando da imagem é `tail -f /dev/null`, então o
# container fica de pé SEM iniciar o Next)
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec next-frontend npm install

# Sobe o servidor de desenvolvimento
docker compose exec -d next-frontend npm run dev
```

A aplicação fica em **http://localhost:3001**.

### ⚠️ Sobre as portas

| | Porta |
|---|---|
| Next.js **dentro** do container | `3000` (default do `next dev`) |
| Publicada **no host** | `3001` |
| API NestJS (outra stack) no host | `3000` |

O mapeamento é `3001:3000` (`compose.yaml`). A 3000 do host é reservada para a API NestJS — as duas stacks rodam na mesma máquina e não podem disputar a mesma porta. **Acesse sempre a 3001 no browser**; a 3000 responde com a API, não com o frontend.

O backend precisa estar no ar para a aplicação funcionar de verdade. Veja a seção "Como rodar" do [README da raiz](../README.md).

## 🔐 Variáveis de ambiente

`lib/env.ts` é a fonte da verdade (`@t3-oss/env-nextjs` + Zod). As variáveis são validadas no boot e no build — valor ausente ou inválido derruba a aplicação.

| Variável | Obrigatória | Descrição |
|---|---|---|
| `API_URL` | sim | Base URL da API NestJS. **Server-only** — não existe variante `NEXT_PUBLIC_*`, e não deve existir (quebraria o modelo BFF). |
| `SESSION_PASSWORD` | sim | Chave de criptografia do cookie de sessão (iron-session). Mínimo 32 caracteres. |
| `MSW_ENABLED` | não | Com `true`, o `instrumentation.ts` sobe o MSW server-side. Usado pelos testes E2E. |

Não declare `NODE_ENV`: o Next.js o define automaticamente e aceita apenas `development`, `production` ou `test`.

Como as stacks Docker são separadas, o `API_URL` aponta para `http://host.docker.internal:3000` (o `extra_hosts` está no `compose.yaml`). Se um dia elas compartilharem a mesma rede Compose, o valor passa a ser `http://nestjs-api:3000`. Detalhes em `.env.example`.

## 📦 Comandos

Dentro do container (`docker compose exec next-frontend …`):

```bash
npm run dev                 # Servidor de desenvolvimento (use -d: não retorna)
npm run build               # Build de produção
npm run start               # Serve o build de produção
npm run lint                # ESLint
npm test                    # Vitest — unit + integração
npm run test:watch          # Vitest em watch mode (use -d)
npm run openapi:types       # Regenera lib/api/types.gen.ts (exige ./openapi.json — veja Arquitetura)
npx tsc --noEmit            # Type-check
npx shadcn@latest add <c>   # Adiciona um primitivo shadcn
```

No host (Docker e sondas de conectividade):

```bash
docker compose ps
docker compose logs next-frontend
curl -I http://localhost:3001
docker compose down
```

## 🧪 Testes

| Sufixo | Tipo | Runner | Onde roda |
|---|---|---|---|
| `*.test.ts(x)` | Unit | Vitest | container |
| `*.integration.test.ts(x)` | Integração (Route Handlers + MSW) | Vitest | container |
| `*.e2e-spec.ts` | End-to-end | Playwright | **host** |

Os E2E rodam no host contra o dev server containerizado, que precisa estar de pé com `MSW_ENABLED=true`:

```bash
docker compose up -d
docker compose exec -d next-frontend sh -c "MSW_ENABLED=true npm run dev"
curl --retry 15 --retry-delay 2 --retry-connrefused -I http://localhost:3001
npx playwright test
```

Sem o `MSW_ENABLED=true` o `instrumentation.ts` não sobe o MSW e as chamadas ao upstream falham ou batem na API NestJS real.

## 🏛️ Arquitetura

Modelo **BFF estrito**: o browser nunca fala com a API NestJS diretamente. Todo tráfego do cliente passa por Route Handlers same-origin em `app/api/**`, que fazem o proxy para o upstream no servidor. Isso elimina CORS e mantém a URL do backend fora do bundle do cliente.

As wire shapes derivam todas do contrato OpenAPI: `openapi.json` → `lib/api/types.gen.ts` (gerado, não editar) → consumidores. Nenhum DTO é duplicado à mão no frontend.

O `openapi.json` deste subprojeto é uma cópia local **não versionada** (está no `.gitignore`) do spec publicado pela API. Para regenerar os tipos, traga o spec do backend primeiro:

```bash
cp ../nestjs-project/openapi.json .
docker compose exec next-frontend npm run openapi:types
```

Convenções detalhadas, tokens de design e regras de integração com Figma estão em [`CLAUDE.md`](./CLAUDE.md).

## 🎨 Stack

React 19 Server Components por padrão, Tailwind CSS v4 (configuração CSS-first via `@theme inline` em `app/globals.css` — **não** existe `tailwind.config.js`), shadcn/ui sobre primitivos `radix-ui`, ícones SVG próprios em `components/icons/` (sem biblioteca externa), fontes `Inter` + `Geist_Mono` via `next/font/google`.

## 📚 Referências

- [Documentação do Next.js](https://nextjs.org/docs)
- [App Router](https://nextjs.org/docs/app)
- [Tailwind CSS v4](https://tailwindcss.com/docs)
- [shadcn/ui](https://ui.shadcn.com)
