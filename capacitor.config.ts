import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kastren.app',
  appName: 'Kastren',
  webDir: 'dist',
  server: {
    cleartext: true,
    androidScheme: 'http'
  },
  ios: {
    contentInset: 'always',
    preferredContentMode: 'mobile',
    scheme: 'Kastren'
  }
};

export default config;
