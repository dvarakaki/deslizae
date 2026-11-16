# Contribuindo com o Deslizae

Obrigado pelo interesse! Este guia explica como preparar o ambiente, rodar os
testes e enviar mudanças.

## Ambiente

```bat
python -m venv .venv
.venv\Scripts\pip install -e .[dev]
.venv\Scripts\python -m pytest
```

- Para testar a página sem mexer no cursor: `python -m deslizae --dry-run -v`.
- Para diagnosticar a rede: `python -m deslizae --stats`.
- Ao alterar `deslizae/static/app.js`, rode `node --check deslizae/static/app.js`.

## Fluxo

1. Crie uma branch a partir de `main` (`feat/pinca-zoom`, `fix/arraste-preso`…).
2. Faça commits pequenos e coesos, seguindo o padrão abaixo.
3. Garanta que `pytest` passa e inclua testes para comportamentos novos.
4. Abra um pull request descrevendo **o quê** e **por quê**.

## Padrão de commits

O projeto segue [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/):

```
<tipo>(<escopo opcional>): <descrição no imperativo, em minúsculas>

<corpo opcional: o porquê da mudança>

<rodapé opcional: BREAKING CHANGE, Closes #123>
```

| Tipo       | Quando usar                                         |
|------------|-----------------------------------------------------|
| `feat`     | nova funcionalidade                                 |
| `fix`      | correção de bug                                     |
| `perf`     | melhoria de desempenho ou latência                  |
| `refactor` | mudança de código sem alterar comportamento         |
| `test`     | testes novos ou ajustes em testes                   |
| `docs`     | documentação                                        |
| `build`    | dependências e empacotamento                        |
| `ci`       | integração contínua                                 |
| `chore`    | tarefas de manutenção                               |

Escopos usados: `input`, `protocol`, `smoother`, `session`, `server`, `cli`, `web`, `pairing`.

Exemplos:

```
feat(web): adiciona pinça para zoom
fix(server): fecha conexões ativas ao encerrar com Ctrl+C
perf(smoother): reduz o buffer mínimo em redes estáveis
```

Mudanças incompatíveis no protocolo entre celular e agente devem usar `!` e o
rodapé `BREAKING CHANGE:`, por exemplo `feat(protocol)!: ...`.
