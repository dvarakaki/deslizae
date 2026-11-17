# Laboratório: mouse pela câmera olhando para o teto

> **Experimental.** Esta branch testa se o celular, deitado na mesa com a tela
> para cima, pode funcionar como um mouse de verdade usando a câmera frontal
> para acompanhar o teto.

## Ideia

Com o celular deslizando na mesa, a câmera frontal vê o teto a ~2 m. Mover o
celular desloca a imagem do teto; medindo esse deslocamento, dá para mover o
cursor. A tela, virada para cima, vira os botões do mouse.

## Pipeline

| Etapa | Técnica | Por quê |
|---|---|---|
| Captura | câmera frontal 640×480 (até 60 fps), recorte central, exposição e balanço de branco travados | a exposição automática muda o brilho a todo instante |
| Anticintilação | cada linha da imagem é dividida pela própria média | lâmpadas LED/fluorescentes piscam e o obturador linha a linha as registra como faixas que andam: falso movimento vertical |
| Deslocamento | correlação de fase com FFT 2D, passa-baixa gaussiano e ajuste gaussiano do pico | erro sub-pixel < 0,06 px nos testes (ajuste parabólico: ~0,2 px) |
| Rastreio | **quadro de referência**: compara com uma imagem fixa e só troca após 8 px ou queda de qualidade | comparar quadro a quadro soma o erro de cada medida; parado, o cursor andaria sozinho |
| Confiança | PSR (nitidez do pico) e contraste | descarta medidas sem textura ou com a câmera coberta |
| Inclinação | giroscópio com **viés estimado** (na calibração e continuamente, quando parado) e matriz de compensação aprendida | inclinar 1° desloca a imagem como arrastar ~3,5 cm; o viés integrado viraria deriva |
| Parado/movendo | detector com histerese: o movimento só vale acima do limiar medido na calibração | parado, o ruído não chega ao cursor |
| Suavização | filtro 1€ (Casiez et al., 2012) | tira o tremor devagar sem atrasar movimentos rápidos |
| Eixos | matriz ortonormal calculada a partir dos gestos "direita" e "frente" | elimina chutes de inversão de eixos |
| Cursor | mesmo protocolo do touchpad (UDP/WebRTC, jitter buffer no PC) | o agente não muda |

## Como testar

1. No PC, nesta branch:

   ```bat
   .venv\Scripts\pip install -r requirements.txt
   .venv\Scripts\python -m deslizae --lab
   ```

2. Abra `http://localhost:8765/pair` no PC e escaneie o QR do cartão **LABORATÓRIO**
   (ou, no touchpad do celular, *Ajustes → Mouse pela câmera*).
3. O celular avisa que o certificado não é confiável (ele foi gerado no seu PC):
   **Avançado → Continuar**.
4. Toque em **Iniciar** e permita a câmera e os sensores de movimento.
5. Deite o celular de **tela para cima**, com o **topo apontando para longe de
   você** (como a frente de um mouse), segurando pela parte de baixo.
6. Toque em **Calibrar (assistente)** e siga os 4 passos:
   1. **Deixe parado**: mede o ruído da sua câmera (define o limiar) e o viés do giroscópio.
   2. **Incline sem deslizar**: aprende quanto cada inclinação desloca a imagem.
   3. **Deslize para a direita** uns 10 cm e pare.
   4. **Deslize para frente** (longe de você) uns 10 cm e pare.
7. Ligue **Enviar ao cursor**.

A calibração fica salva no celular. Refaça se mudar de lugar ou de teto.

Para testar sem celular: `http://localhost:8765/lab?t=CÓDIGO&fake=1` usa um teto
sintético. Pelo console: `window.__fakePause = true` para parar e
`window.__fakeVel = { x: 3, y: 0 }` para mover em linha reta.

## Métricas

| Métrica | O que significa | Bom |
|---|---|---|
| Estado | PARADO, MOVENDO, SEM TEXTURA ou SEM IMAGEM | PARADO quando você solta o celular |
| Câmera | quadros por segundo entregues pelo navegador | ≥ 30 fps |
| Processamento | tempo do cálculo por quadro, no worker | < 15 ms |
| Latência câmera | do sensor até a página, quando o navegador informa | < 80 ms |
| Qualidade (PSR) | quanto o teto tem de textura útil | barra verde |
| Tremor parado | oscilação da posição com o celular imóvel | < 0,10 px |
| Exposição | se a câmera aceitou travar a exposição | travada |

## Ajustes

- **Sensibilidade, Aceleração:** como no touchpad.
- **Suavidade:** corte mínimo do filtro 1€. Menor = mais suave e com mais atraso ao parar.
- **Anticintilação:** desligue apenas se o teto tiver listras horizontais fortes (ela atenua padrões puramente horizontais).
- **Campo amplo:** usa o quadro inteiro; vê mais do teto (útil em teto com pouca textura), mas é menos preciso.
- **Avançado:** limiar de movimento (a calibração define), qualidade mínima, sincronia do giroscópio e inversões manuais de eixos.

## Resultados com o teto sintético

- Parado com ruído de sensor, lâmpada piscando e brilho variando: **0 px** de movimento do cursor.
- Calibração automática: eixos corretos (erro < 0,1 px no eixo transversal).
- "Direita" → cursor para a direita; "frente" → cursor para cima.
- Depois de parar, o restante do movimento chega em até ~0,4 s e o cursor para de vez.
- Deslocamento de 300 px com ~37 trocas de referência: erro < 2% e direção < 0,5°.
  O medidor subestima todo deslocamento em ~0,7% (efeito da janela de Hann),
  igual nos dois eixos: equivale a uma sensibilidade levemente menor.

## O que reportar

- Modelo do celular e navegador.
- Métricas parado e deslizando devagar; se a exposição travou.
- Como é o teto (luminárias, liso, forro) e a altura aproximada.
- Se o cursor ainda se move parado, e se pula ao encostar o dedo (antes/depois da calibração).

## Limitações conhecidas

- Precisão cerca de 10× menor que a de um mouse óptico (~0,2–0,5 mm por pixel de imagem).
- A câmera do celular acrescenta latência (tipicamente 50–100 ms).
- Teto liso sem nada no campo de visão e ventiladores de teto inviabilizam a medida.
- Girar o celular sobre a mesa (em torno do próprio eixo) ainda não é compensado.
