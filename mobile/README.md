# RegulOS Mobile

Aplicativo Android/iOS do RegulOS usando Capacitor.

## Arquitetura

O aplicativo não executa o backend do RegulOS no celular. Ele usa o painel web já publicado no Railway Production:

https://regulos.com.br

O backend continua responsável por autenticação, WhatsApp/Baileys, agendamentos, grupos, entregas, monitor, diagnóstico e IA.

## Desenvolvimento

Na pasta mobile:

```bash
npm install
npx cap add android
npx cap sync android
npx cap open android
```

O projeto Android será gerado localmente pelo Capacitor.

## Regra importante

Não alterar o backend/Production para gerar o APK. A camada mobile deve permanecer separada do servidor.
