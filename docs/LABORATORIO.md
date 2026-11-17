# Laboratório: o celular como mouse

> **Experimental.** O celular fica deitado na mesa, tela para cima, e funciona
> como um mouse de verdade: a câmera frontal acompanha o teto para mover o
> cursor, e a tela vira os botões.

## Como usar

1. No PC, nesta branch:

   ```bat
   .venv\Scripts\pip install -r requirements.txt
   .venv\Scripts\python -m deslizae --lab
   ```

2. Abra `http://localhost:8765/pair` e escaneie o QR do cartão **LABORATÓRIO**
   (ou, no touchpad do celular, *Ajustes → Mouse pela câmera*).
3. O celular avisa que o certificado não é confiável (ele foi gerado no seu PC):
   **Avançado → Continuar**.
4. Toque em **Começar**. A página entra em tela cheia, trava em retrato e abre a câmera.
5. Deite o celular com o **topo apontando para longe de você**. Os **botões ficam em
   cima** (esquerdo, rodinha, direito), como num mouse; a palma fica embaixo. Não
   cubra a câmera (o círculo no topo, no centro).
6. Na primeira vez, o **assistente de calibração** abre sozinho:
   1. **Deixe parado**: mede o ruído da câmera e o viés do giroscópio.
   2. **Balance sem deslizar**: aprende quanto a inclinação desloca a imagem.
   3. **Para a direita**: deslize ~10 cm (pode voltar depois).
   4. **Para frente**: deslize ~10 cm para longe de você (pode voltar).

   Os passos 3 e 4 também calibram o **acelerômetro**: a escala e os eixos (a
   integral da aceleração, com velocidade zero no início e no fim do gesto,
   comparada ao deslocamento da câmera) e o **atraso real da câmera** (o
   deslocamento de tempo que melhor alinha as velocidades medidas pelos dois).
   Gestos decididos (não muito lentos) dão uma calibração melhor.

Pronto: o cursor segue o celular.

**A palma também é um touchpad.** Com o celular parado, a parte de baixo aceita os
mesmos gestos do touchpad (mover, tocar, toque duplo e arrastar, 2 dedos para rolar,
pinça). A rejeição de palma ignora: contato largo (palma), toques novos enquanto o
celular desliza, e um toque parado quando outro dedo chega (a palma apoiada). O
"segurar para arrastar" fica desligado ali, para a palma descansando não virar
arraste; enquanto um dedo usa o touchpad, a câmera não move o cursor. A calibração fica salva; refaça em *Ajustes →
Calibrar* se mudar de lugar. O ponto no canto da palma indica o estado: verde
(parado), azul (movendo), amarelo (sem textura no teto), vermelho (sem conexão).

## Pipeline

| Etapa | Técnica | Por quê |
|---|---|---|
| Captura | câmera frontal a até **120 fps** (cai para 320×240 se for o que libera 120) | mais quadros = menos deslocamento por quadro e menos latência |
| Exposição | **manual e curta** (8 ms, ajustada pelo brilho), balanço de branco travado | no automático, com pouca luz a câmera alonga a exposição e **derruba o fps** (15–20 fps) e borra a imagem |
| Quadros | `MediaStreamTrackProcessor` → worker; só o **plano Y** (luminância) do recorte central do `VideoFrame` (NV12/I420); canvas como reserva | sem cópia GPU→CPU da imagem inteira e sem depender da thread da página; 1,1 ms por quadro no teste |
| Anticintilação | cada linha dividida pela própria média | lâmpadas LED/fluorescentes viram faixas que andam: falso movimento vertical |
| Alinhamento | **Lucas-Kanade inverso-composicional** contra um quadro de referência, partindo da posição prevista; **0,8 ms/quadro** e erro < 0,03 px nos testes | a 120 Hz o deslocamento por quadro é pequeno, o regime ideal do Lucas-Kanade; ~12× mais rápido que a correlação de fase |
| Reserva | correlação de fase (FFT) quando o Lucas-Kanade não converge | movimentos bruscos |
| Sem deriva | quadro de referência fixo, trocado só após 8 px | comparar quadro a quadro soma os erros e o cursor anda sozinho |
| Referencial | vetores convertidos para o referencial do aparelho; tela cheia + trava em retrato, ou rotação por CSS | com o celular deitado, o sistema gira a tela sozinho e os eixos trocariam |
| Inclinação | giroscópio sem viés; compensação só se o ajuste for bom (R² > 0,6) | uma compensação ruim atrapalha mais do que ajuda |
| **Fusão de sensores** | filtro complementar: o **acelerômetro** (≈60 Hz, ~10 ms de atraso) prevê velocidade e posição entre quadros; cada quadro da **câmera** corrige posição e velocidade no instante em que foi capturado | a câmera atrasa 50–100 ms e só atualiza a cada quadro; o acelerômetro sozinho deriva. Na simulação, o atraso até a metade de um gesto cai de **95 ms para 8 ms**, sem deriva e sem passar do alvo |
| Parado/movendo | só "parado" quando câmera **e** acelerômetro estão quietos; limiares medidos na calibração | parado, o ruído não chega ao cursor; o acelerômetro detecta o início do movimento antes da câmera |
| Interpolação no PC | o buffer do agente cobre o **intervalo entre amostras da fonte** (≥ 33 ms para 30 fps), e não só a oscilação da rede | com buffer menor que o intervalo, a interpolação a 240 Hz não tinha a próxima amostra: o cursor andava em **degraus de 30 Hz** (a principal causa do "travado") |
| Eixos | matriz ortonormal pelos gestos "direita" e "frente"; cada gesto vale pelo ponto mais distante e só começa com o celular parado | "deslizar e voltar" não inverte; o fim de um gesto não contamina o seguinte |
| Clique estável | o cursor congela 120 ms ao apertar/soltar botões e ao usar a rodinha | o toque não "empurra" o cursor |
| Cursor | mesmo protocolo do touchpad (UDP/WebRTC, jitter buffer de 240 Hz no PC) | o agente não muda |

## Resultados com o teto sintético

- **Parado** (ruído de sensor, lâmpada piscando, brilho variando): **0 px** de movimento.
- **Direções** após calibrar: direita +x, frente −y (para cima), esquerda −x, trás +y,
  com < 0,1 px no eixo transversal.
- **Calibração com "deslizar e voltar"**: eixos corretos; componente transversal 0,02 px.
- **Ao parar**, o restante do movimento chega em ~0,4 s e o cursor não se mexe mais.

Para testar sem celular: `http://localhost:8765/lab?t=CÓDIGO&fake=1`, com
`window.__fakePause = true` (parar) e `window.__fakeVel = { x: 3, y: 0 }` (mover) no console.

## Diagnóstico

Fica em *Ajustes → Diagnóstico*: fps e resolução reais da câmera, tempo de
processamento, latência da câmera, qualidade do alinhamento (resíduo e método),
tremor parado, giroscópio, exposição, orientação da tela e rede.

## Limitações conhecidas

- A taxa real depende da câmera frontal do aparelho; muitas entregam 30–60 fps.
- A câmera do celular acrescenta latência (tipicamente 50–100 ms).
- Teto liso sem nada no campo de visão e ventiladores de teto inviabilizam a medida.
- Girar o celular sobre a mesa (em torno do próprio eixo) ainda não é compensado.
