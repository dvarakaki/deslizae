"""Ponto de entrada do executável (Deslizae.exe).

Quando aberto com dois cliques, a janela do console fecharia na hora em caso
de erro (porta ocupada, por exemplo), sem dar tempo de ler a mensagem.
"""

import multiprocessing
import sys
import traceback


def run() -> int:
    from deslizae.__main__ import main

    try:
        return main()
    except Exception:  # noqa: BLE001 — mostrar qualquer falha antes de fechar
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    multiprocessing.freeze_support()
    code = run()
    if code and getattr(sys, "frozen", False):
        try:
            input("\n  Pressione Enter para fechar...")
        except EOFError:
            pass
    sys.exit(code)
