import dynamic from 'next/dynamic';

const HandClayApp = dynamic(() => import('@/components/HandClayApp'), { ssr: false });

export default function Home() {
  return <HandClayApp />;
}

