---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-read.e2e-spec.ts
---

# Video Read and Reprocess Test Plan

## Application Overview

`GET /videos/{slug}` é a superfície pela qual um cliente descobre que o processamento terminou. Como a fase decidiu polling em vez de SSE ou WebSocket, este endpoint carrega o ciclo inteiro: `status`, os sete campos de metadados extraídos pelo worker, a URL do thumbnail e — em caso de falha — `processing_error` e `processing_attempts`.

Ele também carrega a regra de visibilidade da fase: um vídeo que ainda não está `ready` responde `404` para quem não é dono, e não `403`, de modo a não revelar a existência do rascunho. Esta fase **não** tem coluna `visibility` — público/unlisted é o eixo ortogonal que chega na Fase 04.

`POST /videos/{slug}/reprocess` é o caminho de recuperação: devolve à fila um vídeo que terminou em `error` depois de esgotar as tentativas, transicionando `error → processing` por update condicional.

## Test Scenarios

### 1. Leitura do recurso de vídeo

**Setup:** `beforeEach` truncar `videos`, `channels` e `users`; bootstrap do módulo de teste NestJS reproduzindo a config global de `main.ts`; criar um usuário dono com canal e um segundo usuário com canal próprio, com access tokens para ambos. Semear vídeos diretamente via repositório nos estados necessários — este grupo não exercita o worker.

#### 1.1. le-video-pronto-de-forma-anonima

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. Semear um vídeo com `status` igual a `ready`, com os sete campos de metadados e `thumbnail_bucket`/`thumbnail_key` preenchidos
  2. `GET /videos/{slug}` **sem** header `Authorization`
    - expect: status `200`
    - expect: corpo com `status` igual a `ready`
    - expect: `duration_seconds` não nulo
    - expect: `thumbnail_url` não nulo
    - expect: `width`, `height`, `codec_name`, `container_format`, `bitrate_bps` e `size_bytes` presentes no corpo

#### 1.2. esconde-rascunho-de-quem-nao-e-dono

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. Semear um vídeo do primeiro usuário com `status` igual a `draft`
  2. `GET /videos/{slug}` com o token do **segundo** usuário
    - expect: status `404`
    - expect: corpo com `error` igual a `VIDEO_NOT_FOUND` — e **não** `403`, para não revelar que o rascunho existe
  3. `GET /videos/{slug}` **sem** header `Authorization`
    - expect: status `404`

#### 1.3. mostra-rascunho-para-o-dono

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `GET /videos/{slug}` do mesmo rascunho, com o token do **dono**
    - expect: status `200`
    - expect: corpo com `status` igual a `draft`
    - expect: `duration_seconds` nulo — o worker ainda não rodou
    - expect: `thumbnail_url` nulo

#### 1.4. expoe-erro-de-processamento

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. Semear um vídeo com `status` igual a `error`, `processing_error` preenchido e `processing_attempts` igual a `3`
  2. `GET /videos/{slug}` com o token do dono
    - expect: status `200`
    - expect: corpo com `status` igual a `error`
    - expect: `processing_error` não nulo
    - expect: `processing_attempts` igual a `3`

### 2. Reprocessamento

**Setup:** herda o Setup do grupo 1; além disso, limpar a fila `video-processing` antes de cada cenário via o helper de fila de teste, para que a contagem de jobs seja observável.

#### 2.1. reenfileira-video-em-erro

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. Semear um vídeo com `status` igual a `error`
  2. `POST /videos/{slug}/reprocess` com o token do dono
    - expect: status `200`
    - expect: corpo com `status` igual a `processing`
    - expect: a linha tem `status` igual a `processing`
    - expect: exatamente 1 job na fila `video-processing` para aquele `videoId`

#### 2.2. rejeita-reprocess-em-estado-nao-erro

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. Semear um vídeo com `status` igual a `ready`
  2. `POST /videos/{slug}/reprocess` com o token do dono
    - expect: status `409`
    - expect: corpo com `error` igual a `VIDEO_INVALID_STATE`
    - expect: a linha permanece com `status` igual a `ready`
    - expect: nenhum job na fila
  3. `POST /videos/{slug}/reprocess` num vídeo em `error` usando o token do **segundo** usuário
    - expect: status `403`
    - expect: corpo com `error` igual a `VIDEO_NOT_OWNED`
    - expect: nenhum job na fila

---

## Coverage note

**AC #7 do SI-03.7** — "Os dois endpoints aparecem no `openapi.json` após `npm run openapi:export`" — **não é coberto por cenário aqui, deliberadamente.** É uma verificação de artefato de build, não de comportamento HTTP, e a UI do Swagger está desligada por padrão (`SWAGGER_ENABLED=false`, por `openapi-docs-nestjs/TD-03`). A verificação vive na checklist de Deliverables do plano, via `npm run openapi:export`.
