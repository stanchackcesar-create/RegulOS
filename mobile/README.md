# RegulOS Mobile

Primeira camada do aplicativo Android/iOS do RegulOS usando Capacitor 8.

## Arquitetura

O backend continua no Railway Production e não é movido para o celular.

Nesta fase de protótipo, o shell mobile carrega o RegulOS publicado em:

https://regulos.com.br

Backend permanece responsável por autenticação, WhatsApp/Baileys, agendamentos, grupos, entregas, monitor, diagnóstico e IA.

## Android

Requisitos: Node.js 22+, Android Studio e Android SDK.

Na pasta mobile:

```bash
npm install
npx cap add android
npx cap sync android
npx cap open android
```

A documentação atual do Capacitor recomenda Android Studio + Android SDK para o desenvolvimento Android.

## Fases

1. Shell Android conectado ao Production.
2. Testes de login, navegação, teclado, voltar e sessão.
3. Ícone, splash, status/navigation bars e identidade RegulOS.
4. Recursos nativos: notificações, compartilhamento, links e armazenamento seguro.
5. Empacotamento da camada web/API para reduzir dependência do carregamento remoto.
6. Assinatura e geração de APK/AAB.
7. Preparação para Google Play e, depois, iOS.

## Regra

Não alterar o backend/Production para gerar o APK. O aplicativo é uma camada separada.
