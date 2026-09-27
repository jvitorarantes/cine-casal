# Cine Casal 💕

Um cineminha para casais: cole o link de um vídeo do **YouTube**, **Google Drive** ou **Dropbox**, escolha um código de sala e assistam juntinhos, em sincronia, mesmo de longe.

## Como funciona

1. Digite **seu nome**, um **código de sala** e o **link do vídeo**.
2. Se a sala não existir, ela é criada e **você controla o filme** (play, pause e avançar/voltar).
3. Mande o código (ou o link da sala, pelo botão *Sala ⧉*) para o seu amor. Ele(a) entra só com nome e código.
4. O vídeo de quem entrou acompanha automaticamente o de quem criou a sala.

Extras: chat ("Cartinhas 💌"), corações que flutuam sobre o vídeo, troca de vídeo pelo criador e retomada do controle se o criador recarregar a página.

## Rodando

```bash
npm install
npm start
# abra http://localhost:3000
```

A porta pode ser alterada com a variável `PORT`. Para usar a dois em lugares diferentes, publique em um serviço com suporte a WebSocket (Render, Railway, Fly.io etc.) com o comando `npm start`.

## Sobre os links de vídeo

- **YouTube (mais prático):** suba o vídeo como *Não listado* (não *Privado*). O YouTube aceita qualquer formato — inclusive .mov do iPhone em HEVC — e converte sozinho. Vídeos com direitos autorais ou com a incorporação desativada não tocam fora do YouTube.
- **Google Drive:** compartilhe como *Qualquer pessoa com o link*. Arquivos muito grandes podem ser bloqueados pelo Drive por limite de download.
- **Dropbox:** use o link de compartilhamento normal; ele é convertido automaticamente para `raw=1`.
- Prefira **.mp4 (H.264/AAC)**, que toca em todos os navegadores. Outros links diretos para arquivos de vídeo também funcionam.

O vídeo é carregado diretamente do YouTube/Drive/Dropbox pelo navegador de cada pessoa; o servidor só troca as mensagens de sincronização.
