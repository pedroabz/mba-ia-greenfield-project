---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-upload.e2e-spec.ts
---

# Upload Handshake Test Plan

## Application Overview

Os três endpoints que cercam o upload de um vídeo. `POST /videos` pré-cadastra o vídeo como rascunho **antes** do primeiro byte, devolvendo o `slug` público, a object key autoritativa e o part size que o cliente deve usar para fatiar o arquivo. `POST /videos/{id}/upload/sign` assina uma operação S3 por chamada — o cliente envia os bytes direto ao storage, nunca pela API, que é o que permite 10GB sem travar o processo Node. `POST /videos/{id}/upload-complete` fecha o handshake: verifica via `HeadObject` que o objeto existe e tem o tamanho declarado, e só então transiciona o status e enfileira o processamento na mesma transação.

O endpoint de assinatura é a superfície de segurança desta fase: ele trata a `key` recebida como não confiável e a valida contra a key gravada no rascunho em **toda** operação, para não virar um oráculo de assinatura aberto.

## Test Scenarios

### 1. Pré-cadastro do rascunho

**Setup:** `beforeEach` truncar as tabelas `videos`, `channels` e `users`; bootstrap do módulo de teste NestJS reproduzindo a config global de `main.ts` (`ValidationPipe`, filtro de exceções de domínio, guard JWT global); criar um usuário com canal e obter um access token.

#### 1.1. cria-rascunho-com-corpo-valido

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `POST /videos` com `{ title, declared_size_bytes, content_type }` válidos e header `Authorization: Bearer <token>`
    - expect: status `201`
    - expect: corpo contém `id`, `slug`, `uploadKey` e `part_size_bytes`
    - expect: `slug` tem 11 caracteres
    - expect: `part_size_bytes` é positivo e divide 10 GiB em menos de 10.000 partes
  2. Consultar a tabela `videos` pelo `id` retornado
    - expect: a linha existe com `status` igual a `draft`
    - expect: `declared_size_bytes` igual ao valor enviado
    - expect: `video_key` igual ao `uploadKey` devolvido
    - expect: `processing_attempts` igual a `0`
    - expect: os sete campos de metadados estão `NULL`

#### 1.2. rejeita-rascunho-sem-token

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `POST /videos` com corpo válido e **sem** header `Authorization`
    - expect: status `401`
    - expect: nenhuma linha nova na tabela `videos`

### 2. Assinatura de operações S3

**Setup:** herda o Setup do grupo 1; além disso, criar um rascunho via `POST /videos` e guardar `id` e `uploadKey`; criar um **segundo** usuário com canal próprio e seu access token, para os cenários de posse.

#### 2.1. rejeita-key-que-nao-pertence-ao-rascunho

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `POST /videos/{id}/upload/sign` com `{ method: "PUT", key: "videos/outro-id/original.mp4", upload_id, part_number: 1 }` e o token do dono
    - expect: status `403`
    - expect: corpo com `error` igual a `UPLOAD_KEY_MISMATCH`
    - expect: nenhuma URL assinada no corpo da resposta
  2. `POST /videos/{id}/upload/sign` com a `key` correta do rascunho
    - expect: status `200`
    - expect: corpo contém `url` e `expires_in`
    - expect: o host da `url` é o valor de `S3_ENDPOINT_PUBLIC`, não o de `S3_ENDPOINT_INTERNAL`

#### 2.2. rejeita-assinatura-por-usuario-que-nao-e-dono

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `POST /videos/{id}/upload/sign` com a `key` correta mas usando o token do **segundo** usuário
    - expect: status `403`
    - expect: corpo com `error` igual a `VIDEO_NOT_OWNED`
  2. `POST /videos/{id}/upload/sign` com `{ method: "GET", upload_id, part_number_marker }` para `ListParts`, com o token do dono
    - expect: status `200`
    - expect: corpo contém `url` — a paginação de `ListParts` é assinável, não uma chamada única

### 3. Conclusão do upload e integridade

**Setup:** herda o Setup do grupo 2. Para os cenários que precisam de objeto gravado, usar o helper de storage de teste (`src/test/storage.ts`) para gravar um objeto na `uploadKey` do rascunho com um tamanho controlado.

#### 3.1. rejeita-conclusao-sem-objeto-no-storage

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. `POST /videos/{id}/upload-complete` com o token do dono, **sem** nada gravado na key
    - expect: status `409`
    - expect: corpo com `error` igual a `UPLOAD_OBJECT_MISSING`
    - expect: a linha permanece com `status` igual a `draft`
    - expect: nenhum job na fila `video-processing`

#### 3.2. rejeita-conclusao-com-tamanho-divergente

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. Gravar na `uploadKey` um objeto com tamanho **diferente** de `declared_size_bytes`
  2. `POST /videos/{id}/upload-complete` com o token do dono
    - expect: status `409`
    - expect: corpo com `error` igual a `UPLOAD_SIZE_MISMATCH`
    - expect: a linha permanece com `status` igual a `draft`
    - expect: nenhum job na fila `video-processing`

#### 3.3. conclui-e-enfileira-uma-unica-vez-em-chamada-duplicada

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-01T17:54:00Z

**Steps:**
  1. Gravar na `uploadKey` um objeto com tamanho **exatamente** igual a `declared_size_bytes`
  2. `POST /videos/{id}/upload-complete` com o token do dono
    - expect: status `200`
    - expect: corpo com `status` igual a `processing`
    - expect: a linha tem `status` igual a `processing`
    - expect: exatamente 1 job na fila `video-processing` com payload contendo `videoId`, `videoBucket` e `videoKey`
  3. `POST /videos/{id}/upload-complete` uma **segunda** vez, com o mesmo token
    - expect: a linha continua com `status` igual a `processing`
    - expect: continua existindo exatamente 1 job na fila — a transição é um update condicional, então a segunda chamada é no-op
