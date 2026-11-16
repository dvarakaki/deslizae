<div align="center">

<img src="deslizae/static/icon.svg" width="96" alt="Ícone do Deslizae">

# Deslizae

**Transforme qualquer celular em touchpad do seu PC com Windows: direto do navegador, sem instalar app.**

[![CI](https://github.com/dvarakaki/deslizae/actions/workflows/ci.yml/badge.svg)](https://github.com/dvarakaki/deslizae/actions/workflows/ci.yml)
![Python](https://img.shields.io/badge/python-3.11%2B-3776AB?logo=python&logoColor=white)
![Plataforma](https://img.shields.io/badge/plataforma-Windows-0078D6?logo=windows&logoColor=white)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green.svg)](LICENSE)

</div>

---

O Deslizae é composto por um agente leve que roda no PC e uma página web que
abre no celular. Escaneie um QR code e a tela do celular vira um touchpad
completo, com gestos, rolagem com inércia, zoom de pinça e arraste, com baixa
latência mesmo em Wi-Fi instável.

## Destaques

- **Sem app no celular:** funciona no navegador de qualquer Android ou iPhone.
- **Pareamento por QR code:** escaneou, conectou. Nas próximas vezes, o celular conecta sozinho.
- **Baixa latência:** movimentos vão por **UDP (WebRTC)**, então perdas no Wi-Fi não travam o cursor,
  e um *jitter buffer* adaptativo reproduz o movimento no ritmo original do dedo.
- **Gestos de touchpad de verdade:** clique, botão direito, rolagem com inércia, pinça para zoom,
  toque duplo para arrastar.
- **Em pé ou deitado:** a interface gira mesmo com a rotação automática desligada.
- **Seguro na rede local:** só aceita conexões com o código do QR; a página de pareamento só abre no próprio PC.

## Como funciona

```
 Celular (navegador)                               PC (Windows)
┌────────────────────────┐   UDP (WebRTC)        ┌──────────────────────────────┐
│ página do touchpad     │ ════════════════════▶ │ agente Python                │
│ gestos → posições      │   WebSocket (reserva  │ jitter buffer → SendInput    │
│ acumuladas + instante  │ ────────────────────▶ │ move o cursor                │
└────────────────────────┘   e sinalização)      └──────────────────────────────┘
```

1. O agente sobe um servidor local e mostra um QR code com o endereço e um código de pareamento.
2. O celular abre a página, conecta por WebSocket (já autenticado) e negocia um canal WebRTC
   sem reenvio, ou seja, UDP, direto pela rede local, sem servidores externos.
3. Cada gesto vira uma mensagem binária de poucos bytes; o agente injeta o mouse com a API
   `SendInput` do Windows.

## Começando

Você precisa de um PC com **Windows 10 ou 11** e de um celular conectado na
**mesma rede** que ele (o mesmo Wi-Fi, por exemplo). No celular não se instala nada.

### Opção 1: baixar e usar (recomendado)

Não precisa de Python nem de terminal.

1. **Baixe o [`Deslizae.exe`](https://github.com/dvarakaki/deslizae/releases/latest)**
   na página de releases, em *Assets*.
2. **Dê dois cliques no arquivo.** Como o executável ainda não tem assinatura
   digital, o Windows pode mostrar *"O Windows protegeu o computador"*: clique em
   **Mais informações → Executar assim mesmo**.
3. **Libere o acesso à rede.** O Firewall do Windows pergunta se o Deslizae pode
   se comunicar: marque **Redes privadas** e clique em **Permitir acesso**.
4. **Escaneie o QR code.** Abre no PC uma página com o QR code; aponte a câmera
   do celular para ele e toque no link que aparecer.
5. **Pronto.** A tela do celular é o touchpad. O indicador **UDP** verde no topo
   mostra que a conexão está no modo mais rápido.

Para encerrar, feche a janela preta do Deslizae. Nas próximas vezes, abra o
`Deslizae.exe` e, no celular, o mesmo link. Dica: no navegador do celular, use
**Adicionar à tela inicial** para virar um atalho.

### Opção 2: rodar pelo código-fonte

1. Instale o **[Python 3.11 ou mais novo](https://www.python.org/downloads/)**.
   Na primeira tela do instalador, marque **"Add python.exe to PATH"**.
2. Baixe o projeto: botão **Code → Download ZIP** nesta página (e extraia), ou
   `git clone https://github.com/dvarakaki/deslizae.git`.
3. Dê dois cliques em **`iniciar.bat`**. Na primeira vez ele prepara o ambiente
   e instala as dependências, o que leva alguns minutos.
4. Siga os passos 3 a 5 da opção 1.

### Não conectou?

Confira nesta ordem:

1. **Mesma rede.** Celular e PC precisam estar no mesmo Wi-Fi (ou o PC no cabo do
   mesmo roteador). Redes de visitantes e muitas redes corporativas **isolam os
   aparelhos** entre si. Se for o caso, ative o **roteador/hotspot do celular** e
   conecte o PC nele: funciona igual.
2. **Firewall.** Se você clicou em *Cancelar* no aviso do Firewall, abra
   *Permitir um aplicativo pelo Firewall do Windows* no menu Iniciar, clique em
   **Alterar configurações** e marque **Privada** na linha do *Deslizae* (ou do
   *Python*, na opção 2).
3. **Tipo de rede.** Em *Configurações → Rede e Internet → Wi-Fi* (ou
   *Ethernet*) → sua rede, escolha **Rede privada**. Em rede pública o Windows
   bloqueia conexões de entrada.
4. **VPN ou vários endereços.** A página de pareamento lista os outros endereços
   do PC em *"O celular não conecta?"*; tente cada um no navegador do celular.
5. **Antivírus.** Alguns bloqueiam executáveis novos. Libere o `Deslizae.exe` ou
   use a opção 2.

## Gestos

| Gesto                               | Ação                                         |
|-------------------------------------|----------------------------------------------|
| 1 dedo arrastando                   | move o cursor (com aceleração)               |
| toque                               | clique esquerdo                              |
| toque duplo                         | clique duplo                                 |
| toque duplo e arrastar              | arrastar / selecionar                        |
| segurar parado ~0,5 s e arrastar    | arrastar / selecionar                        |
| toque com 2 dedos                   | clique direito                               |
| toque com 3 dedos                   | clique do meio                               |
| 2 dedos arrastando                  | rolagem vertical e horizontal, com inércia   |
| pinça (abrir/fechar 2 dedos)        | zoom (Ctrl + rodinha)                        |
| botões na parte de baixo            | botões físicos (segure + mova para arrastar) |

### Ajustes no celular

Tudo fica salvo no próprio celular: sensibilidade, aceleração, velocidade da
rolagem, rolagem natural, inércia, toque duplo, pinça, vibração, suavização,
conexão UDP e orientação.

- **Orientação:** o botão de girar na barra alterna **Automática → Em pé → Deitado**. Se o
  celular não girar a tela sozinho, a interface gira 90° e os toques são convertidos para o
  novo sentido. Use **Inverter lado** se ela ficar de cabeça para baixo.
- **Toque duplo e arrastar:** com essa opção ligada, o clique simples espera 0,2 s por um
  segundo toque, como no touchpad do Windows. Sem a espera, "clique + apertar" viraria
  clique duplo e abriria o arquivo em vez de arrastá-lo. Desligue para cliques instantâneos.
- **Indicador UDP/TCP:** mostra o caminho em uso. Em verde (UDP), perdas no Wi-Fi não travam o cursor.

## Linha de comando

```
Deslizae.exe [opções]            (executável)
python -m deslizae [opções]      (código-fonte)

opções: [--port 8765] [--no-browser] [--new-token] [--stats] [--dry-run] [-v]
```

| Opção          | Descrição                                                                 |
|----------------|---------------------------------------------------------------------------|
| `--port`       | porta do servidor (padrão: a salva, ou 8765)                              |
| `--no-browser` | não abre a página de pareamento automaticamente                           |
| `--new-token`  | gera um novo código de pareamento (desconecta celulares já pareados)      |
| `--stats`      | a cada 2 s, mostra ritmo, perdas, caminho (udp/tcp) e suavização em uso   |
| `--dry-run`    | não mexe no cursor, só registra; útil para desenvolver                    |
| `-v`           | log detalhado                                                             |

A configuração (código de pareamento e porta) fica em `%APPDATA%\Deslizae\config.json`.

## Decisões técnicas

| Problema | Solução |
|---|---|
| No TCP, um pacote perdido segura todos os seguintes por ~200 ms até ser reenviado. | Canal de dados **WebRTC sem reenvio e fora de ordem** (UDP). Perda vira só um pacote a menos. WebSocket fica como reserva automática. |
| Com UDP, pacotes podem se perder, duplicar ou chegar fora de ordem. | Movimento, rolagem e zoom levam a **posição acumulada** com número de sequência; cliques têm **id único**, vão pelos dois caminhos e carregam a posição do cursor. |
| O Wi-Fi entrega em rajadas, com buracos de dezenas de ms. | **Jitter buffer adaptativo** (10–60 ms): cada movimento leva o instante do toque e é reproduzido a 240 Hz, com interpolação, no ritmo original do dedo. |
| Movimento relativo injetado sofre a aceleração do Windows. | Posicionamento **absoluto** no desktop virtual, com mapeamento exato pixel a pixel e acúmulo de frações de pixel. |
| A curva de aceleração precisa de tempos precisos. | Calculada **no celular**, que tem os timestamps reais dos toques. |
| Rede engasgada formaria fila e o cursor "andaria atrasado". | O celular envia só a **posição mais recente** quando o canal está ocupado. |
| Conexão cai no meio de um arraste. | O agente **solta os botões** automaticamente. |
| Tela do celular apagando. | Wake Lock quando disponível; na rede local (HTTP), um vídeo mudo de 2 KB em loop. |

O formato das mensagens está documentado em [`deslizae/protocol.py`](deslizae/protocol.py).

## Solução de problemas

Para problemas de conexão, veja [Não conectou?](#não-conectou).

<details>
<summary><b>O indicador mostra TCP em vez de UDP</b></summary>

O WebRTC não conseguiu abrir o caminho UDP, geralmente por bloqueio do firewall. O
Deslizae continua funcionando pelo WebSocket, mas fica mais sensível a perdas no Wi-Fi.
Verifique se o Deslizae (ou o Python) está liberado no firewall para a rede atual.
</details>

<details>
<summary><b>O cursor não mexe em algumas janelas</b></summary>

Janelas abertas **como administrador** e a tela do UAC não aceitam entrada de programas
comuns (proteção do Windows). Abra o Deslizae com **Executar como administrador** para controlá-las.
</details>

<details>
<summary><b>iPhone</b></summary>

O Safari não oferece vibração nem tela cheia pelo botão. Use **Compartilhar → Adicionar à
Tela de Início** para abrir em tela cheia; o atalho já abre pareado.
</details>

## Desenvolvimento

```bat
python -m venv .venv
.venv\Scripts\pip install -e .[dev]
.venv\Scripts\python -m pytest
```

Para trabalhar na página sem mexer no cursor, use `python -m deslizae --dry-run -v`.

### Gerando o executável

```bat
.venv\Scripts\pip install -e .[build]
.venv\Scripts\python -m PyInstaller packaging\deslizae.spec --noconfirm
```

O resultado fica em `dist\Deslizae.exe`. Ao publicar uma tag `vX.Y.Z`, o workflow
[`release.yml`](.github/workflows/release.yml) gera o executável, roda os testes e
o anexa à release com o SHA-256 e as notas do CHANGELOG.

### Estrutura

```
deslizae/
  __main__.py     CLI, inicialização e QR code no terminal
  server.py       HTTP + WebSocket (aiohttp), sinalização WebRTC (aiortc), pareamento
  session.py      aplica mensagens de forma idempotente (perda, duplicata, ordem)
  smoother.py     jitter buffer e reprodução a 240 Hz
  protocol.py     protocolo binário
  win_input.py    injeção de mouse via SendInput (ctypes, sem dependências)
  config.py       código de pareamento e porta persistentes
  netinfo.py      descoberta do IP local
  static/         página do celular (index.html, app.js, style.css) e de pareamento
tests/            testes automatizados (pytest), incluindo WebRTC ponta a ponta
packaging/        receita do PyInstaller, ponto de entrada e ícone do executável
scripts/          utilitários (ícones e notas de release)
```

## Contribuindo

Contribuições são bem-vindas. Leia o [CONTRIBUTING.md](CONTRIBUTING.md): o projeto
segue [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/). O
histórico de versões está no [CHANGELOG.md](CHANGELOG.md).

## Licença

Distribuído sob a licença MIT. Veja [LICENSE](LICENSE).
