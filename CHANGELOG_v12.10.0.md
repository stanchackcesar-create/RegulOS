# RegulOS v12.10.0 — Programação dinâmica

Quando um agendamento é considerado definitivamente não enviado:

- o link falho sai da programação ativa;
- o próximo link ocupa o horário que ficou livre;
- os seguintes avançam uma posição;
- o horário original continua registrado;
- o envio confirmado como sucesso não é reorganizado.

Exemplo:
08:00 A / 09:00 B / 10:00 C
A falha → 08:00 B / 09:00 C.

A lógica é persistida em `dynamic_schedule.json`.
