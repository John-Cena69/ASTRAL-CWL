import { useEffect, useRef } from 'react';

interface Star {
  x: number;
  y: number;
  z: number;
  size: number;
  opacity: number;
  twinkleSpeed: number;
  twinkleOffset: number;
}

interface ShootingStar {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
}

const STAR_COUNT = 220;
const SHOOTING_STAR_INTERVAL = 6000;

export default function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const stars: Star[] = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * width,
        y: Math.random() * height,
        z: Math.random() * 0.8 + 0.2,
        size: Math.random() * 1.8 + 0.3,
        opacity: Math.random() * 0.5 + 0.3,
        twinkleSpeed: Math.random() * 0.02 + 0.005,
        twinkleOffset: Math.random() * Math.PI * 2,
      });
    }

    const shootingStars: ShootingStar[] = [];

    let lastShootingStar = 0;
    let frame = 0;
    let rafId = 0;

    const drawNebula = () => {
      const g1 = ctx.createRadialGradient(width * 0.2, height * 0.3, 0, width * 0.2, height * 0.3, width * 0.5);
      g1.addColorStop(0, 'rgba(126, 34, 206, 0.08)');
      g1.addColorStop(1, 'rgba(126, 34, 206, 0)');
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, width, height);

      const g2 = ctx.createRadialGradient(width * 0.8, height * 0.7, 0, width * 0.8, height * 0.7, width * 0.4);
      g2.addColorStop(0, 'rgba(180, 83, 9, 0.05)');
      g2.addColorStop(1, 'rgba(180, 83, 9, 0)');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, width, height);
    };

    const render = (time: number) => {
      frame++;
      ctx.clearRect(0, 0, width, height);
      drawNebula();

      for (const star of stars) {
        const tw = Math.sin(time * star.twinkleSpeed + star.twinkleOffset) * 0.4 + 0.6;
        const alpha = star.opacity * tw * star.z;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size * star.z, 0, Math.PI * 2);
        if (star.z > 0.7) {
          ctx.fillStyle = `rgba(251, 191, 36, ${alpha})`;
        } else {
          ctx.fillStyle = `rgba(216, 180, 254, ${alpha})`;
        }
        ctx.fill();
      }

      if (time - lastShootingStar > SHOOTING_STAR_INTERVAL && Math.random() > 0.3) {
        lastShootingStar = time;
        const startX = Math.random() * width * 0.5;
        const startY = Math.random() * height * 0.3;
        shootingStars.push({
          x: startX,
          y: startY,
          vx: Math.random() * 3 + 4,
          vy: Math.random() * 2 + 1.5,
          life: 0,
          maxLife: 80,
          size: Math.random() * 1.5 + 1,
        });
      }

      for (let i = shootingStars.length - 1; i >= 0; i--) {
        const ss = shootingStars[i];
        ss.x += ss.vx;
        ss.y += ss.vy;
        ss.life++;

        const progress = ss.life / ss.maxLife;
        const alpha = progress < 0.5 ? progress * 2 : (1 - progress) * 2;

        const tailLength = 60;
        const gradient = ctx.createLinearGradient(
          ss.x,
          ss.y,
          ss.x - ss.vx * tailLength / 4,
          ss.y - ss.vy * tailLength / 4
        );
        gradient.addColorStop(0, `rgba(251, 191, 36, ${alpha})`);
        gradient.addColorStop(1, 'rgba(251, 191, 36, 0)');
        ctx.strokeStyle = gradient;
        ctx.lineWidth = ss.size;
        ctx.beginPath();
        ctx.moveTo(ss.x, ss.y);
        ctx.lineTo(ss.x - ss.vx * tailLength / 4, ss.y - ss.vy * tailLength / 4);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(ss.x, ss.y, ss.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 235, 170, ${alpha})`;
        ctx.fill();

        if (ss.life >= ss.maxLife || ss.x > width || ss.y > height) {
          shootingStars.splice(i, 1);
        }
      }

      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);

    const handleResize = () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 -z-10 pointer-events-none"
      aria-hidden="true"
    />
  );
}
