import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'br.com.regulos.app',
  appName: 'RegulOS',
  webDir: 'web',
  server: {
    url: 'https://regulos.com.br',
    cleartext: false,
    androidScheme: 'https'
  }
};

export default config;
