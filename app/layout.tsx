import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';

import type { Metadata, Viewport } from 'next';
import {
  ColorSchemeScript,
  MantineProvider,
  createTheme,
  mantineHtmlProps,
} from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import DevNav from './components/DevNav';

const theme = createTheme({
  primaryColor: 'violet',
  fontFamily: 'var(--font-geist-sans), sans-serif',
  fontFamilyMonospace: 'var(--font-geist-mono), monospace',
});

export const metadata: Metadata = {
  title: 'Line Imposter',
  description: 'Multiplayer drawing and guessing game',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript defaultColorScheme="dark" />
      </head>
      <body>
        <MantineProvider theme={theme} defaultColorScheme="dark">
          <Notifications />
          {children}
          {process.env.NODE_ENV === 'development' && <DevNav />}
        </MantineProvider>
      </body>
    </html>
  );
}
