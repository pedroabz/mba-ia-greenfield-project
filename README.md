# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>

---

## Quadro Branco

- [Quadro Branco](./whiteboard.png)

---

## 🎨 Design System (Figma)

- [FC Tube.fig](./FC%20Tube.fig) — arquivo-fonte do **design system** do projeto no Figma.
- [FC Tube sem padrão.fig](./FC%20Tube%20sem%20padrao.fig) — arquivo-fonte puro, sem tokens, cores, tipografia e espaçamento.

Contém os fundamentos visuais do StreamTube — tokens (cores, tipografia, espaçamento, raios), componentes e as telas da plataforma. É a referência de design para a implementação do frontend: os componentes em `next-frontend/components/ui` (shadcn) e os tokens em `next-frontend/app/globals.css` derivam deste arquivo. Abra-o no Figma (`Arquivo → Importar`) para consultar especificações e estados visuais.

---

## 📋 Pré-requisitos

- Docker e Docker Compose
- Node.js v25+ (para rodar os testes E2E do Playwright no host)
- npm

## 🏗️ Arquitetura

O projeto é um monorepo baseado em containers Docker. Cada subprojeto sobe sua própria stack via `docker compose`.

- **Frontend** (Next.js 16, App Router + React Server Components) — interface da plataforma. Segue o **modelo BFF**: o navegador nunca chama a API NestJS diretamente; todo tráfego passa por Route Handlers same-origin em `app/api/**`, que fazem proxy server-side para a API.
- **API** (NestJS 11) — regras de negócio, autenticação (JWT + refresh token rotation), envio de e-mails e acesso ao banco.
- **Database** (PostgreSQL 17) — usuários, canais, vídeos e tokens de autenticação.
- **Email Service** (Mailpit) — captura os e-mails transacionais (confirmação de conta e recuperação de senha) em uma UI local.
- **Object Storage** (MinIO, compatível com S3) — dois buckets: `streamtube-videos` e `streamtube-thumbnails`. O upload vai **direto do cliente para o storage** via URLs pré-assinadas; nenhum byte de vídeo passa pela API.
- **Video Worker** (FFmpeg) — container próprio, **sem servidor HTTP**. Consome a fila, extrai metadados com `ffprobe` e gera o thumbnail com `ffmpeg`, de modo que um processamento de vários minutos não ocupa o event loop da API.
- **Message Queue** (`pg-boss` sobre o PostgreSQL existente) — fila durável de processamento. **Não há serviço de broker separado:** a fila é um schema `pgboss` dentro do próprio banco, e é exatamente isso que torna o enfileiramento transacional — a linha do vídeo e o job dela commitam (ou revertem) juntos, então nunca existe um vídeo em `processing` sem job nem um job órfão. A justificativa completa está em `docs/decisions/technical-decisions-phase-03-videos.md` (TD-07, TD-17).

O diagrama de arquitetura completo (C4) está em `docs/diagrams/software-arch.mermaid`.

## 🚀 Como rodar

Os dois subprojetos têm stacks Docker **separadas**. Suba primeiro o backend, rode as migrations e depois o frontend.

### 1. Backend (NestJS + PostgreSQL + Mailpit)

```bash
cd nestjs-project

# Cria o .env (obrigatório — sem ele DB_HOST cai no fallback "localhost" e a
# conexão com o banco falha com ECONNREFUSED 127.0.0.1:5432)
cp .env.example .env

# Sobe API, banco e Mailpit
docker compose up -d

# Instala dependências (apenas na primeira vez).
# Rode SEMPRE dentro do container: binários nativos são específicos de
# plataforma, e um "npm install" no host (macOS) quebra o boot no container.
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor de desenvolvimento em watch mode
docker compose exec -d nestjs-api npm run start:dev
```

Serviços disponíveis:

| Serviço | URL / Porta |
|---------|-------------|
| API NestJS | http://localhost:3000 |
| PostgreSQL | `localhost:5432` (db/user/senha: `streamtube`) |
| Mailpit (UI de e-mails) | http://localhost:8025 |
| MinIO (API S3) | `localhost:9000` (user/senha: `streamtube`) |
| MinIO (console web) | http://localhost:9001 |
| Swagger (opcional) | http://localhost:3000/api/docs — habilite com `SWAGGER_ENABLED=true` |

### 2. Frontend (Next.js)

```bash
cd next-frontend

# Cria o .env.local (obrigatório — lib/env.ts valida as vars no boot)
# API_URL aponta para o backend; SESSION_PASSWORD protege a sessão (iron-session)
cp .env.example .env.local

# Gere um SESSION_PASSWORD próprio (mínimo 32 caracteres)
openssl rand -base64 32

docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira vez
docker compose exec -d next-frontend npm run dev
```

A aplicação ficará disponível em **http://localhost:3001**.

> As stacks são separadas, então o frontend acessa o backend via `host.docker.internal:3000` (configurado em `next-frontend/.env.local` e no `extra_hosts` do compose).

## 🧪 Testes

### Backend (Jest)

```bash
cd nestjs-project
# Rode no container `video-worker`: ele tem o mesmo código e as mesmas dependências
# do `nestjs-api`, **mais** os binários ffmpeg/ffprobe que as suítes de vídeo exigem.
docker compose exec video-worker npm test -- --runInBand   # unitários + integração
docker compose exec video-worker npm run test:e2e          # end-to-end (HTTP via supertest)
docker compose exec video-worker npm run test:cov          # cobertura
```

Sufixos: `*.spec.ts` (unitário), `*.integration-spec.ts` (integração com banco real), `*.e2e-spec.ts` (end-to-end). Integração e e2e compartilham um único banco e **precisam** rodar em série — `npm test` exige `--runInBand` explícito e o config de e2e já fixa `maxWorkers: 1`.

### Frontend (Vitest + Playwright)

```bash
cd next-frontend
docker compose exec next-frontend npm test            # unitários + integração (Vitest + MSW)
npx playwright test                                   # end-to-end (no host, com dev server em MSW_ENABLED=true)
```

Sufixos: `*.test.ts(x)` (unitário), `*.integration.test.ts(x)` (Route Handlers com MSW), `*.e2e-spec.ts` (Playwright). MSW intercepta as chamadas à API NestJS — os testes nunca batem no backend real.

## ✅ Funcionalidades implementadas

**Fase 01 — Configuração base** e **Fase 02 — Autenticação** estão concluídas (backend + frontend). **Fase 03 — Upload e Processamento de Vídeos** está concluída no backend (o frontend desta fase não faz parte do escopo dela).

### Autenticação (Fase 02)

Fluxo completo de **cadastro → confirmação por e-mail → login → recuperação de senha**, com canal criado automaticamente para cada usuário (a partir do prefixo do e-mail).

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /auth/register` | Cadastro de usuário (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Confirmação de conta via link do e-mail |
| `POST /auth/resend-confirmation` | Reenvio do e-mail de confirmação |
| `POST /auth/login` | Login (retorna access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token (com family + grace period) |
| `POST /auth/logout` | Revoga os refresh tokens da sessão |
| `POST /auth/forgot-password` | Solicita e-mail de recuperação de senha |
| `POST /auth/reset-password` | Redefine a senha via token |
| `GET /auth/me` | Dados do usuário autenticado (protegido por JWT) |

Telas e Route Handlers BFF (`next-frontend`):

- `/(auth)/signup`, `/(auth)/login`, `/(auth)/forgot-password` — formulários com React Hook Form + Zod e validação inline.
- `app/api/auth/{signup,login,logout,forgot-password}` — proxy same-origin para a API.

Segurança: senhas com **Argon2**, **JWT** com `JwtAuthGuard` global (opt-out via `@Public()`), **rotação de refresh token** com detecção de reuso, **rate limiting** (`ThrottlerGuard`) nos endpoints de auth, e sessão no navegador via **iron-session** (cookies HTTP-only).

### Vídeos (Fase 03 — backend)

Upload de arquivos grandes, processamento automático em segundo plano e entrega por streaming.

| Método & Rota | Auth | Descrição |
|---------------|------|-----------|
| `POST /videos` | dono | Pré-cadastra o vídeo como `draft` e devolve a `uploadKey` autoritativa e o `part_size_bytes` |
| `POST /videos/{id}/upload/sign` | dono | Assina **uma** operação S3 (criar multipart, enviar parte, listar partes, concluir, abortar) |
| `POST /videos/{id}/upload-complete` | dono | Verifica o objeto gravado e transiciona `draft → processing`, enfileirando o processamento |
| `GET /videos/{slug}` | público¹ | Status e metadados do vídeo — a superfície de polling |
| `POST /videos/{slug}/reprocess` | dono | Reenfileira um vídeo que terminou em `error` |
| `GET /videos/{slug}/stream` | público | Reprodução por range (`206 Partial Content`) |
| `GET /videos/{slug}/download` | público | Download do arquivo (`Content-Disposition: attachment`) |

¹ Um vídeo que ainda não está `ready` é visível **apenas ao dono**; para qualquer outro chamador a resposta é `404`, não `403`, para não revelar que o rascunho existe.

Como o upload funciona — e por que suporta arquivos de 10 GB sem travar o sistema:

1. O cliente chama `POST /videos` **antes** de enviar qualquer byte. A linha nasce em `draft` e o servidor decide a chave do objeto (o cliente nunca a propõe).
2. O cliente pede uma URL assinada por operação e envia as partes **direto para o object storage**. Nenhum byte de vídeo atravessa a API — é isso que torna o tamanho do arquivo irrelevante para a performance dela. A `key` enviada para assinatura é tratada como não confiável e revalidada contra o rascunho em toda chamada, para que o endpoint não sirva de oráculo de assinatura.
3. `POST /videos/{id}/upload-complete` confere, via `HeadObject`, que o objeto existe e que o tamanho **bate com o declarado** — uma checagem de integridade que detecta upload truncado ou multipart concluído de forma incorreta. Não existe limite de tamanho nesta fase: nenhuma fonte do projeto pede um.
4. A transição para `processing` e o enfileiramento acontecem **na mesma transação**, então a linha e o job commitam juntos.
5. O `video-worker` consome o job, extrai os metadados (duração, dimensões, codec, container, bitrate, tamanho) com `ffprobe`, gera o thumbnail com `ffmpeg` a ~10% da duração e leva o vídeo a `ready` — ou a `error` com `processing_error` preenchido, recuperável via `reprocess`.

Ciclo de status: `draft → processing → ready | error`. Publicação **não** faz parte deste enum — `visibility` é um eixo ortogonal, da Fase 04.

Cada vídeo recebe uma URL única via `slug` `nanoid(11)` em coluna `UNIQUE`, com retry em colisão.

## 🛠️ Estrutura do Projeto

```
green-field-ia-project/
├── docs/
│   ├── project-plan.md                  # Planejamento geral do projeto
│   ├── phases/                          # Planos e implementação por fase
│   │   ├── phase-01-configuracao-base/
│   │   ├── phase-02-auth/               # Auth (backend)
│   │   ├── phase-02-auth-frontend/      # Auth (frontend)
│   │   └── phase-03-videos/             # Upload e processamento (backend)
│   ├── decisions/                       # Decisões técnicas por escopo (TDs)
│   └── diagrams/
│       └── software-arch.mermaid        # Diagrama de arquitetura (C4)
├── nestjs-project/                      # Backend API (NestJS 11)
│   ├── src/
│   │   ├── auth/                        # Cadastro, login, JWT, refresh, reset de senha
│   │   ├── users/                       # Entidade e serviço de usuários
│   │   ├── channels/                    # Canal 1:1 por usuário (nickname do e-mail)
│   │   ├── videos/                      # Domínio de vídeo: handshake de upload, leitura, entrega
│   │   ├── storage/                     # Único módulo que fala com o SDK S3 (presign, range, head)
│   │   ├── queue/                       # Porta estreita sobre pg-boss (enfileiramento transacional)
│   │   ├── worker/                      # Handler de processamento, FfmpegService e draft-reaper
│   │   ├── mail/                        # Envio de e-mails (templates Handlebars)
│   │   ├── common/                      # Filtros, pipes e exceptions de domínio
│   │   ├── config/                      # Configs namespaced (Joi)
│   │   ├── database/                    # data-source, migrations e seeds
│   │   ├── main.ts                      # Entrypoint da API
│   │   └── main.worker.ts               # Entrypoint do worker (contexto standalone, sem HTTP)
│   ├── specs/                           # Contratos de teste e2e por feature
│   ├── test/                            # Testes e2e
│   ├── compose.yaml                     # Compose (API + PostgreSQL + Mailpit + MinIO + worker)
│   └── Dockerfile.dev                   # Multi-stage: `base` (API) e `worker` (com ffmpeg)
├── next-frontend/                       # Frontend (Next.js 16, App Router)
│   ├── app/                             # Rotas, layouts, páginas e Route Handlers BFF
│   ├── components/                      # Componentes de auth, UI (shadcn) e ícones
│   ├── lib/                             # env, api (openapi-fetch), auth/session
│   ├── mocks/                           # MSW (handlers + server)
│   ├── tests/                           # E2E (Playwright)
│   ├── compose.yaml                     # Docker Compose (dev server)
│   └── Dockerfile.dev
├── CLAUDE.md                            # Instruções para IA
├── FC Tube.fig                          # Design system do projeto (Figma)
├── whiteboard.png                       # Quadro branco do projeto
└── README.md
```

## 📚 Fases do Projeto

| Fase | Descrição | Status |
|------|-----------|--------|
| **01** | Configuração Base do Projeto | ✅ Concluída |
| **02** | Cadastro, Login e Gerenciamento de Conta | ✅ Concluída |
| **03** | Upload e Processamento de Vídeos | ✅ Concluída (backend) |
| **04** | Gerenciamento de Vídeos e Canal | ⏳ Planejada |
| **05** | Página de Visualização do Vídeo | ⏳ Planejada |
| **06** | Interações Sociais (Likes, Comentários, Inscrições) | ⏳ Planejada |
| **07** | Página Inicial, Busca e Finalização | ⏳ Planejada |

Detalhes completos em `docs/project-plan.md`.

## 📖 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form + Zod, iron-session, openapi-fetch |
| Backend | NestJS 11, TypeScript, TypeORM, JWT, Argon2, Mailer (Handlebars) |
| Banco de Dados | PostgreSQL 17 |
| Object Storage | MinIO (API S3), via `@aws-sdk/client-s3` v3 + presigner |
| Fila | `pg-boss` sobre o próprio PostgreSQL (sem broker separado) |
| Processamento de vídeo | FFmpeg / ffprobe, em container de worker dedicado |
| E-mail (dev) | Mailpit |
| Containerização | Docker, Docker Compose |
| Testes | Jest, Supertest (backend); Vitest, MSW, Playwright (frontend) |
| Qualidade | ESLint, Prettier |
</content>
