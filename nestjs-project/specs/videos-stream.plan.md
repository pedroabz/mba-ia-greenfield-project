---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: nestjs-project/test/videos-stream.e2e-spec.ts
---

# Video Streaming and Download Test Plan

## Application Overview

`GET /videos/{slug}/stream` serve os bytes do vídeo como respostas de range HTTP, para que a reprodução comece sem o cliente baixar o arquivo inteiro — o requisito "sem necessidade de download completo" da fase. O handler lê o header `Range`, repassa o intervalo de bytes ao storage (sem buscar o objeto inteiro e fatiar em memória) e responde `206` com `Content-Range`.

`GET /videos/{slug}/download` aponta para o **mesmo** handler, diferindo apenas no `Content-Disposition: attachment`. Esta fase decidiu servir os bytes pela API em vez de redirecionar para uma URL pré-assinada, o que dá autorização por requisição em troca de um hop de Node no caminho de leitura.

A autorização é verificada **antes** de abrir o stream: o vídeo precisa estar `ready`, e fora disso o acesso é aberto, inclusive anônimo — alinhado com o requisito de visualização anônima do plano do projeto. Não há distinção público/unlisted nesta fase; essa coluna chega na Fase 04.

## Test Scenarios

### 1. Streaming por range

**Setup:** `beforeEach` truncar `videos`, `channels` e `users`; bootstrap do módulo de teste NestJS reproduzindo a config global de `main.ts`; criar um usuário com canal. Gravar no bucket de vídeos, via o helper de storage de teste (`src/storage/storage.test-harness.ts`), um objeto de tamanho conhecido — a fixture `src/test/fixtures/sample.mp4` serve — e semear um vídeo `ready` apontando para aquela key.

#### 1.1. serve-range-parcial-com-206

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `GET /videos/{slug}/stream` com header `Range: bytes=0-1023`
    - expect: status `206`
    - expect: header `Content-Range` igual a `bytes 0-1023/{tamanho total do objeto}`
    - expect: header `Accept-Ranges` igual a `bytes`
    - expect: header `Content-Length` igual a `1024`
    - expect: corpo com exatamente 1024 bytes
  2. `GET /videos/{slug}/stream` com header `Range: bytes=1024-2047`
    - expect: status `206`
    - expect: os bytes retornados diferem dos da primeira requisição — o range é realmente repassado ao storage, não ignorado

#### 1.2. serve-corpo-completo-sem-header-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `GET /videos/{slug}/stream` **sem** header `Range`
    - expect: status `200`
    - expect: header `Accept-Ranges` igual a `bytes`
    - expect: `Content-Length` igual ao tamanho total do objeto

#### 1.3. rejeita-range-insatisfazivel

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `GET /videos/{slug}/stream` com `Range: bytes={tamanho+1000}-{tamanho+2000}`
    - expect: status `416`
    - expect: corpo com `error` igual a `RANGE_NOT_SATISFIABLE`

#### 1.4. permite-acesso-anonimo-a-video-pronto

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `GET /videos/{slug}/stream` com `Range: bytes=0-1023` e **sem** header `Authorization`
    - expect: status `206`
    - expect: header `Content-Range` presente — a visualização não exige token

### 2. Guarda de estado

**Setup:** herda o Setup do grupo 1; além disso, semear vídeos nos estados `draft`, `processing` e `error` apontando para keys sem objeto gravado.

#### 2.1. rejeita-streaming-de-video-nao-pronto

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `GET /videos/{slug}/stream` de um vídeo com `status` igual a `processing`
    - expect: status `409`
    - expect: corpo com `error` igual a `VIDEO_NOT_READY`
  2. `GET /videos/{slug}/stream` de um vídeo com `status` igual a `draft`
    - expect: status `409`
    - expect: corpo com `error` igual a `VIDEO_NOT_READY`
  3. `GET /videos/{slug}/stream` com um `slug` inexistente
    - expect: status `404`
    - expect: corpo com `error` igual a `VIDEO_NOT_FOUND`

### 3. Download

**Setup:** herda o Setup do grupo 1.

#### 3.1. serve-download-como-anexo

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `GET /videos/{slug}/download` sem header `Range`
    - expect: status `200`
    - expect: header `Content-Disposition` começa com `attachment;`
    - expect: o `filename` no `Content-Disposition` contém o `slug` do vídeo
    - expect: header `Accept-Ranges` igual a `bytes`
  2. `GET /videos/{slug}/download` de um vídeo com `status` igual a `processing`
    - expect: status `409`
    - expect: corpo com `error` igual a `VIDEO_NOT_READY`

---

## Coverage note

**AC #7 do SI-03.8** — "Os dois endpoints aparecem no `openapi.json` após `npm run openapi:export`" — **não é coberto por cenário aqui, deliberadamente.** É verificação de artefato de build, não de comportamento HTTP, e a UI do Swagger está desligada por padrão (`SWAGGER_ENABLED=false`, por `openapi-docs-nestjs/TD-03`). A verificação vive na checklist de Deliverables do plano, via `npm run openapi:export`.
