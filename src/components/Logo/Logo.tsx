import { useConfig } from '@/config/hooks'
import { useLingui } from '@lingui/react/macro'
import clsx from 'clsx'
import styles from './Logo.module.scss'

export const Logo = ({
  logo,
  focusedLogo,
  name,
  className,
}: {
  logo?: string
  focusedLogo?: string
  name?: string
  className?: string
}) => {
  const { darkModeLogoStyle } = useConfig()
  const { t } = useLingui()
  if (!logo && !name) return null
  return (
    <div className={styles.logoContainer}>
      {logo && (
        <img
          src={logo}
          className={clsx(
            styles.logo,
            darkModeLogoStyle === 'invert' && styles.darkInvert,
            focusedLogo ? styles.unfocusedLogo : null,
            className,
          )}
          alt={name ? t`logo of ${name}` : ''}
        />
      )}
      {focusedLogo && (
        <img
          src={focusedLogo}
          className={clsx(
            styles.logo,
            darkModeLogoStyle && styles.darkInvert,
            styles.focusedLogo,
            className,
          )}
          alt={name ? t`focused logo of ${name}` : ''}
        />
      )}
      {name ? <span>{name}</span> : null}
    </div>
  )
}
