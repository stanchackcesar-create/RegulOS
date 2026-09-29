# RegulOS v12.9.0

## Captura inteligente de produto

O RegulOS agora tenta capturar título/imagem em camadas:

1. HTML direto;
2. metadados Open Graph/Twitter;
3. JSON-LD;
4. imagens lazy/srcset/background;
5. navegador Chromium renderizado como fallback.

O navegador é carregado sob demanda e reutilizado durante a execução para reduzir custo. A URL continua passando pela validação de destino seguro antes da navegação e antes do download da imagem.

### Configuração

`REGULOS_BROWSER_FALLBACK=true` ativa o fallback.
Use `false` para desativá-lo.

### Cloud

O Docker instala Chromium e dependências necessárias durante o build.
