# O Leo está trabalhando?

Painel ao vivo com dois quadros: **webcam** e **tela do AnyDesk**. Quem tem o
link e o PIN acompanha pelo celular ou pelo PC, sem instalar nada.

## Como funciona

- O PC do Leo abre `/host`, autoriza a câmera e compartilha a janela do AnyDesk.
- O navegador captura e envia quadros JPEG para o servidor.
- O servidor retransmite para os espectadores em MJPEG (`/api/mjpeg`), com
  presença e status em tempo real via SSE.
- Nada é gravado: os quadros ficam apenas na memória do servidor.

## Rodar localmente

Requisitos: Node.js 20 ou superior.

```bash
npm start
```

Variáveis opcionais:

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `PORT` | `3000` | Porta do servidor |
| `ACCESS_PIN` | PIN salvo ou aleatório | PIN de acesso ao painel |
| `AUTH_SECRET` | segredo salvo ou aleatório | Assina o cookie de sessão |

No Windows, dá para usar `iniciar.bat`. Exemplo manual:

```powershell
$env:ACCESS_PIN='12345678'
$env:AUTH_SECRET='troque-este-segredo'
node server.mjs
```

Depois abra:

- Painel: `http://localhost:3000`
- Transmissão: `http://localhost:3000/host`

O terminal mostra também os endereços da rede local para abrir no celular
(por exemplo, `http://192.168.0.10:3000`).

## Transmitir

1. Abra `/host` no PC e entre com o PIN.
2. Ligue a webcam e autorize a câmera.
3. Clique em **Compartilhar janela** e escolha a janela do AnyDesk.
4. Deixe a aba aberta. O ideal é usar **Abrir em janela separada**: assim o
   navegador não reduz tanto a taxa de quadros quando ela fica atrás de outros
   programas. Não minimize a janela.
5. Use os botões de status (Trabalhando, Em pausa, Almoçando, No banheiro,
   Ausente) para avisar quem está assistindo.

## Publicar na internet

O app usa estado em memória, então rode **uma única instância** (sem múltiplas
réplicas). O `render.yaml` e o `Dockerfile` já estão prontos:

- **Render**: suba o projeto em um repositório e crie um Blueprint a partir do
  `render.yaml`; defina `ACCESS_PIN` e deixe o `AUTH_SECRET` ser gerado.
- **Docker**:

  ```bash
  docker build -t leo-painel .
  docker run -p 3000:3000 -e ACCESS_PIN=12345678 -e AUTH_SECRET=segredo leo-painel
  ```

- Para HTTPS sem deploy, um túnel (Cloudflare Tunnel, ngrok etc.) apontando para
  a porta 3000 também funciona. Nesse caso, use o endereço HTTPS nos links.

> A contagem de "pessoas assistindo" é real: conta **sessões de navegador
> autenticadas**, não abas. Várias abas no mesmo navegador contam como uma
> pessoa. Cada celular/PC com login conta como uma.

## Segurança

- Troque o PIN e o `AUTH_SECRET` antes de expor o app na internet.
- O acesso é protegido por PIN + cookie assinado (HMAC), com limite de
  tentativas de login.
- A transmissão é privada, mas trafega pelo servidor: use HTTPS em produção.
- O arquivo `data/state.json` guarda o PIN/segredo e não deve ir para o
  repositório nem para a imagem Docker.
