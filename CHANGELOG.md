# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
projeto adota o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Corrigido

- Encerrar o agente enquanto um celular está conectado por WebRTC podia lançar
  `CancelledError`, quando o encerramento e a desconexão fechavam a mesma conexão
  ao mesmo tempo.

## [0.1.0] - 2026-11-16

Primeira versão.

### Adicionado

- Agente para Windows que injeta o mouse via `SendInput`, com posicionamento absoluto
  exato e acúmulo de frações de pixel.
- Página de touchpad para o navegador do celular, sem instalar app.
- Pareamento por QR code com código persistente e página de pareamento local.
- Transporte por UDP (canal de dados WebRTC sem reenvio) com WebSocket como reserva.
- Protocolo binário tolerante a perda, duplicação e reordenação.
- Jitter buffer adaptativo com reprodução a 240 Hz e interpolação.
- Gestos: clique, toque duplo, toque duplo e arrastar, segurar e arrastar, botão direito,
  clique do meio, rolagem com inércia e pinça para zoom.
- Orientação em pé ou deitado, com rotação da interface quando o celular não gira a tela.
- Ajustes salvos no celular: sensibilidade, aceleração, rolagem, vibração e outros.
- Diagnóstico de rede com `--stats`.

[Não lançado]: https://github.com/dvarakaki/deslizae/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dvarakaki/deslizae/releases/tag/v0.1.0
